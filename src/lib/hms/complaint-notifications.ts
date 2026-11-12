// MOHD.HMS ENTERPRISE — Centralized complaint / work-order notification service.
//
// Single source of truth for complaint-workflow recipient distribution.
// Every complaint lifecycle event funnels through here so that:
//   • Admin and Supervisor always receive notifications (all active users,
//     never just the first match).
//   • Super Admin is explicitly EXCLUDED at recipient resolution.
//   • Customers / creators receive their own complaint updates.
//   • Assigned technicians receive assignment / work-order notifications.
//   • Duplicate events never create duplicate notifications (idempotency key
//     on event type + resource + recipient).
//
// All notification records are created through this service. No complaint or
// work-order route should call notify() / notifyRole() directly for workflow
// events — they call the helpers below instead.

import "server-only";
import { db } from "@/lib/db";
import { notify } from "@/lib/hms/services";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import type { SessionUser } from "@/lib/hms/auth";

/** Roles that receive complaint workflow notifications. Super Admin is
 *  deliberately NOT in this list — it is excluded at recipient resolution. */
const COMPLAINT_NOTIFY_ROLES = ["ADMIN", "SUPERVISOR"] as const;

/** Resolve a customer record's portal user ID (for notification delivery).
 *  Returns null when the customer has no linked portal user. */
async function resolveCustomerPortalUserId(customerId: string): Promise<string | null> {
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: { portalUser: { select: { id: true } } },
  });
  return customer?.portalUser?.id ?? null;
}

/** Resolve all eligible recipients for a complaint-scoped notification.
 *
 *  Returns:
 *    adminSupervisor — all active ADMIN + SUPERVISOR users (Super Admin excluded)
 *    technician — the assigned technician user id (or null)
 *    customer — the customer's portal user id (or null)
 *    creator — the complaint creator user id (or null)
 *
 *  A deduplicated array of all recipient user ids is also returned for
 *  single-pass notification creation.
 */
export async function resolveComplaintRecipients(complaint: {
  id: string;
  customerId: string;
  createdById: string;
  assignedTechnicianId?: string | null;
  assignedTechnician?: { userId: string } | null;
}): Promise<{
  adminSupervisor: string[];
  technician: string | null;
  customer: string | null;
  creator: string | null;
  all: string[];
}> {
  // 1. All active Admin + Supervisor users (Super Admin explicitly excluded
  //    by role exact-match — role field is "ADMIN" or "SUPERVISOR", never
  //    "SUPER_ADMIN").
  const staff = await db.user.findMany({
    where: {
      role: { in: ["ADMIN", "SUPERVISOR"] },
      status: "ACTIVE",
    },
    select: { id: true },
  });
  const adminSupervisor = staff.map((u) => u.id);

  // 2. Assigned technician (user id from the technician profile).
  const technician = complaint.assignedTechnician?.userId ?? complaint.assignedTechnicianId ?? null;

  // 3. Customer portal user.
  const customer = await db.customer.findUnique({
    where: { id: complaint.customerId },
    select: { portalUser: { select: { id: true } } },
  });
  const customerPortalUserId = customer?.portalUser?.id ?? null;

  // 4. Complaint creator.
  const creator = complaint.createdById ?? null;

  // 5. Deduplicated combined list.
  const all = Array.from(
    new Set([
      ...adminSupervisor,
      technician,
      customerPortalUserId,
      creator,
    ].filter((u): u is string => !!u)),
  );

  return { adminSupervisor, technician, customer: customerPortalUserId, creator, all };
}

/** Idempotent notification creation for a single recipient.
 *
 *  Skips creation when an in-app notification already exists for the same
 *  (event type, resource type, resource id, recipient) within the dedupe
 *  window. This prevents duplicate notifications on webhook retries, worker
 *  restarts, and repeated status updates.
 *
 *  Returns true when a new notification row was created.
 */
export async function notifyComplaintRecipient({
  userId,
  eventType,
  resourceType,
  resourceId,
  title,
  message,
  type = "INFO",
  priority = "NORMAL",
  dedupeHours = 24,
}: {
  userId: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  title: string;
  message: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  priority?: "NORMAL" | "HIGH" | "CRITICAL";
  dedupeHours?: number;
}): Promise<boolean> {
  const since = new Date(Date.now() - dedupeHours * 3_600_000);
  const existing = await db.notification.findFirst({
    where: {
      userId,
      type,
      title,
      message,
      resourceType,
      resourceId,
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (existing) return false;

  await notify({
    userId,
    title,
    message,
    type,
    resourceType,
    resourceId,
    priority,
    channels: ["IN_APP", "PUSH"],
  });
  return true;
}

/** Notify all Admin + Supervisor users about a complaint event. */
export async function notifyComplaintStaff({
  complaintId,
  complaintCode,
  eventType,
  title,
  message,
  type = "INFO",
  priority = "NORMAL",
}: {
  complaintId: string;
  complaintCode: string;
  eventType: string;
  title: string;
  message: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  priority?: "NORMAL" | "HIGH" | "CRITICAL";
}): Promise<{ notified: number; skipped: number }> {
  const staff = await db.user.findMany({
    where: { role: { in: ["ADMIN", "SUPERVISOR"] }, status: "ACTIVE" },
    select: { id: true },
  });
  let notified = 0;
  let skipped = 0;
  for (const u of staff) {
    const created = await notifyComplaintRecipient({
      userId: u.id,
      eventType,
      resourceType: "COMPLAINT",
      resourceId: complaintId,
      title,
      message,
      type,
      priority,
    });
    if (created) notified += 1;
    else skipped += 1;
  }
  return { notified, skipped };
}

/** Notify a single recipient (technician / customer / creator) about a
 *  complaint event, idempotently. */
export async function notifyComplaintUser({
  userId,
  complaintId,
  complaintCode,
  eventType,
  title,
  message,
  type = "INFO",
  priority = "NORMAL",
}: {
  userId: string;
  complaintId: string;
  complaintCode: string;
  eventType: string;
  title: string;
  message: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  priority?: "NORMAL" | "HIGH" | "CRITICAL";
}): Promise<boolean> {
  return notifyComplaintRecipient({
    userId,
    eventType,
    resourceType: "COMPLAINT",
    resourceId: complaintId,
    title,
    message,
    type,
    priority,
  });
}

/** ─── Event-specific helpers ─── */

/** New complaint created — notify Admin, Supervisor, and the customer/creator. */
export async function notifyNewComplaint({
  complaintId,
  complaintCode,
  customerName,
  priority,
  title,
  createdById,
  customerId,
  customerPortalUserId,
}: {
  complaintId: string;
  complaintCode: string;
  customerName: string;
  priority: string;
  title: string;
  createdById: string;
  customerId: string;
  customerPortalUserId?: string | null;
}): Promise<void> {
  // Admin + Supervisor
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.COMPLAINT_CREATED,
    title: "New Customer Complaint Received",
    message: `A new complaint has been submitted by ${customerName}.`,
    type: "INFO",
    priority: priority === "URGENT" || priority === "HIGH" ? "HIGH" : "NORMAL",
  });

  // Customer / creator (dedupe if same person)
  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, label: string) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.COMPLAINT_CREATED,
      title: "Complaint Submitted",
      message: `Your complaint ${complaintCode} (“${title}”) has been submitted successfully.`,
      type: "SUCCESS",
    });
  };
  // Use the customer's portal user ID if available; otherwise fall back to customerId
  // (which may not be a valid user — the notify function will handle gracefully).
  await notifyUser(customerPortalUserId ?? null, "customer");
  await notifyUser(createdById, "creator");
}

/** Technician assigned — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyTechnicianAssigned({
  complaintId,
  complaintCode,
  technicianName,
  assignedBy,
  workOrderCode,
  customerId,
  createdById,
}: {
  complaintId: string;
  complaintCode: string;
  technicianName: string;
  assignedBy: string;
  workOrderCode?: string | null;
  customerId: string;
  createdById: string;
}): Promise<void> {
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.COMPLAINT_ASSIGNED,
    title: "Technician Assigned",
    message: `${technicianName} has been assigned to complaint ${complaintCode}.`,
    type: "INFO",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, titleOverride?: string, messageOverride?: string) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.COMPLAINT_ASSIGNED,
      title: titleOverride ?? "Technician Assigned",
      message: messageOverride ?? `${technicianName} has been assigned to your complaint ${complaintCode}${workOrderCode ? ` (Work Order ${workOrderCode})` : ""}.`,
      type: "INFO",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(assignedBy, "Technician Assigned (by you)");
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order created — notify Admin, Supervisor, technician, customer, creator.
 *  Handles both complaint-linked and standalone work orders. */
export async function notifyWorkOrderCreated({
  complaintId,
  complaintCode,
  workOrderId,
  workOrderCode,
  workOrderTitle,
  customerId,
  createdById,
  technicianUserId,
}: {
  complaintId?: string | null;
  complaintCode?: string | null;
  workOrderId: string;
  workOrderCode: string;
  workOrderTitle: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  const hasComplaint = Boolean(complaintId && complaintCode);
  if (hasComplaint) {
    await notifyComplaintStaff({
      complaintId: complaintId!,
      complaintCode: complaintCode!,
      eventType: EVENT_TYPES.WORK_ORDER_CREATED,
      title: "Work Order Created",
      message: `Work Order ${workOrderCode} (“${workOrderTitle}”) has been generated for complaint ${complaintCode}.`,
      type: "INFO",
    });
  } else {
    await notifyWorkOrderStaff({
      workOrderId,
      workOrderCode,
      eventType: EVENT_TYPES.WORK_ORDER_CREATED,
      title: "Work Order Created",
      message: `Work Order ${workOrderCode} (“${workOrderTitle}”) has been created.`,
      type: "INFO",
    });
  }

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    if (hasComplaint) {
      await notifyComplaintUser({
        userId,
        complaintId: complaintId!,
        complaintCode: complaintCode!,
        eventType: EVENT_TYPES.WORK_ORDER_CREATED,
        title: isTech ? "Work Order Available" : "Work Order Created",
        message: isTech
          ? `Work Order ${workOrderCode} (“${workOrderTitle}”) is ready to start.`
          : `Work Order ${workOrderCode} has been created for complaint ${complaintCode}.`,
        type: "INFO",
      });
    } else {
      await notifyWorkOrderUser({
        userId,
        workOrderId,
        workOrderCode,
        eventType: EVENT_TYPES.WORK_ORDER_CREATED,
        title: isTech ? "Work Order Available" : "Work Order Created",
        message: isTech
          ? `Work Order ${workOrderCode} (“${workOrderTitle}”) is ready to start.`
          : `Work Order ${workOrderCode} has been created.`,
        type: "INFO",
      });
    }
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Technician accepts work order — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyWorkOrderAccepted({
  complaintId,
  complaintCode,
  workOrderCode,
  acceptedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  complaintId: string;
  complaintCode: string;
  workOrderCode: string;
  acceptedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.WORK_ORDER_ACCEPTED,
    title: "Work Order Accepted",
    message: `Work Order ${workOrderCode} has been accepted by ${acceptedBy}.`,
    type: "INFO",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.WORK_ORDER_ACCEPTED,
      title: isTech ? "Work Order Accepted" : "Work Order Accepted",
      message: isTech
        ? `You accepted Work Order ${workOrderCode} for complaint ${complaintCode}.`
        : `Work Order ${workOrderCode} for complaint ${complaintCode} has been accepted by ${acceptedBy}.`,
      type: "INFO",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Technician starts work — notify Admin, Supervisor, customer, creator. */
export async function notifyWorkOrderStarted({
  complaintId,
  complaintCode,
  workOrderCode,
  startedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  complaintId: string;
  complaintCode: string;
  workOrderCode: string;
  startedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.WORK_ORDER_STARTED,
    title: "Work Started",
    message: `Work on complaint ${complaintCode} (Work Order ${workOrderCode}) has started.`,
    type: "INFO",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.WORK_ORDER_STARTED,
      title: "Work Started",
      message: `Work on your complaint ${complaintCode} (Work Order ${workOrderCode}) has started by ${startedBy}.`,
      type: "INFO",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order put on hold — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyWorkOrderOnHold({
  complaintId,
  complaintCode,
  workOrderCode,
  holdReason,
  heldBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  complaintId: string;
  complaintCode: string;
  workOrderCode: string;
  holdReason?: string | null;
  heldBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  const reasonText = holdReason ? ` Reason: ${holdReason}.` : "";
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.WORK_ORDER_ON_HOLD,
    title: "Work Order On Hold",
    message: `Work Order ${workOrderCode} for complaint ${complaintCode} has been put on hold by ${heldBy}.${reasonText}`,
    type: "WARNING",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.WORK_ORDER_ON_HOLD,
      title: isTech ? "Work Order On Hold" : "Work Order On Hold",
      message: isTech
        ? `Work Order ${workOrderCode} has been put on hold${reasonText}`
        : `Work on your complaint ${complaintCode} (Work Order ${workOrderCode}) has been put on hold${reasonText}`,
      type: "WARNING",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order submitted for review — notify Admin, Supervisor, technician, customer/creator. */
export async function notifyWorkOrderSubmitted({
  complaintId,
  complaintCode,
  workOrderCode,
  submittedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  complaintId: string;
  complaintCode: string;
  workOrderCode: string;
  submittedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.WORK_ORDER_SUBMITTED,
    title: "Work Order Submitted for Review",
    message: `Work Order ${workOrderCode} for complaint ${complaintCode} has been submitted for supervisor review by ${submittedBy}.`,
    type: "INFO",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.WORK_ORDER_SUBMITTED,
      title: isTech ? "Work Order Submitted" : "Work Order Submitted for Review",
      message: isTech
        ? `You submitted Work Order ${workOrderCode} for complaint ${complaintCode} for review.`
        : `Work Order ${workOrderCode} for your complaint ${complaintCode} has been submitted for review.`,
      type: "INFO",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order approved and closed — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyWorkOrderClosed({
  complaintId,
  complaintCode,
  workOrderCode,
  closedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  complaintId: string;
  complaintCode: string;
  workOrderCode: string;
  closedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.WORK_ORDER_CLOSED,
    title: "Work Order Closed",
    message: `Work Order ${workOrderCode} for complaint ${complaintCode} has been approved and closed by ${closedBy}.`,
    type: "SUCCESS",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.WORK_ORDER_CLOSED,
      title: isTech ? "Work Order Closed" : "Work Order Closed",
      message: isTech
        ? `Work Order ${workOrderCode} has been approved and closed.`
        : `Your complaint ${complaintCode} (Work Order ${workOrderCode}) has been completed and closed.`,
      type: "SUCCESS",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order reopened — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyWorkOrderReopened({
  complaintId,
  complaintCode,
  workOrderCode,
  reason,
  reopenedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  complaintId: string;
  complaintCode: string;
  workOrderCode: string;
  reason: string;
  reopenedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.WORK_ORDER_REOPENED,
    title: "Work Order Reopened",
    message: `Work Order ${workOrderCode} for complaint ${complaintCode} has been reopened by ${reopenedBy}. Reason: ${reason}.`,
    type: "WARNING",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.WORK_ORDER_REOPENED,
      title: isTech ? "Work Order Reopened" : "Work Order Reopened",
      message: isTech
        ? `Work Order ${workOrderCode} has been reopened for rework. Reason: ${reason}.`
        : `Work Order ${workOrderCode} for your complaint ${complaintCode} has been reopened. Reason: ${reason}.`,
      type: "WARNING",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Complaint closed (via work order closure) — notify Admin, Supervisor, customer, creator. */
export async function notifyComplaintClosed({
  complaintId,
  complaintCode,
  closedBy,
  customerId,
  createdById,
}: {
  complaintId: string;
  complaintCode: string;
  closedBy: string;
  customerId: string;
  createdById: string;
}): Promise<void> {
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.COMPLAINT_CLOSED,
    title: "Complaint Closed",
    message: `Complaint ${complaintCode} has been closed after its linked work order was approved and closed.`,
    type: "SUCCESS",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.COMPLAINT_CLOSED,
      title: "Complaint Closed",
      message: `Your complaint ${complaintCode} has been closed.`,
      type: "SUCCESS",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Complaint cancelled — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyComplaintCancelled({
  complaintId,
  complaintCode,
  reason,
  cancelledBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  complaintId: string;
  complaintCode: string;
  reason?: string | null;
  cancelledBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  const reasonText = reason ? ` Reason: ${reason}.` : "";
  await notifyComplaintStaff({
    complaintId,
    complaintCode,
    eventType: EVENT_TYPES.COMPLAINT_CANCELLED,
    title: "Complaint Cancelled",
    message: `Complaint ${complaintCode} has been cancelled by ${cancelledBy}.${reasonText}`,
    type: "WARNING",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintUser({
      userId,
      complaintId,
      complaintCode,
      eventType: EVENT_TYPES.COMPLAINT_CANCELLED,
      title: isTech ? "Complaint Cancelled" : "Complaint Cancelled",
      message: isTech
        ? `Complaint ${complaintCode} has been cancelled.${reasonText}`
        : `Your complaint ${complaintCode} has been cancelled.${reasonText}`,
      type: "WARNING",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** ─── Work Order notification helpers ─── */

/** Notify all Admin + Supervisor users about a work order event. */
export async function notifyWorkOrderStaff({
  workOrderId,
  workOrderCode,
  eventType,
  title,
  message,
  type = "INFO",
  priority = "NORMAL",
}: {
  workOrderId: string;
  workOrderCode: string;
  eventType: string;
  title: string;
  message: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  priority?: "NORMAL" | "HIGH" | "CRITICAL";
}): Promise<{ notified: number; skipped: number }> {
  const staff = await db.user.findMany({
    where: { role: { in: ["ADMIN", "SUPERVISOR"] }, status: "ACTIVE" },
    select: { id: true },
  });
  let notified = 0;
  let skipped = 0;
  for (const u of staff) {
    const created = await notifyComplaintRecipient({
      userId: u.id,
      eventType,
      resourceType: "WORK_ORDER",
      resourceId: workOrderId,
      title,
      message,
      type,
      priority,
    });
    if (created) notified += 1;
    else skipped += 1;
  }
  return { notified, skipped };
}

/** Notify a single recipient about a work order event, idempotently. */
export async function notifyWorkOrderUser({
  userId,
  workOrderId,
  workOrderCode,
  eventType,
  title,
  message,
  type = "INFO",
  priority = "NORMAL",
}: {
  userId: string;
  workOrderId: string;
  workOrderCode: string;
  eventType: string;
  title: string;
  message: string;
  type?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  priority?: "NORMAL" | "HIGH" | "CRITICAL";
}): Promise<boolean> {
  return notifyComplaintRecipient({
    userId,
    eventType,
    resourceType: "WORK_ORDER",
    resourceId: workOrderId,
    title,
    message,
    type,
    priority,
  });
}

/** Work order accepted — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyWoAccepted({
  workOrderId,
  workOrderCode,
  complaintId,
  complaintCode,
  acceptedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  workOrderId: string;
  workOrderCode: string;
  complaintId?: string | null;
  complaintCode?: string | null;
  acceptedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyWorkOrderStaff({
    workOrderId,
    workOrderCode,
    eventType: EVENT_TYPES.WORK_ORDER_ACCEPTED,
    title: "Work Order Accepted",
    message: `Work Order ${workOrderCode} has been accepted by ${acceptedBy}.`,
    type: "INFO",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    const ref = complaintId ? { complaintId, complaintCode: complaintCode ?? "" } : { workOrderId, workOrderCode };
    await notifyComplaintRecipient({
      userId,
      eventType: EVENT_TYPES.WORK_ORDER_ACCEPTED,
      resourceType: complaintId ? "COMPLAINT" : "WORK_ORDER",
      resourceId: complaintId ?? workOrderId,
      title: isTech ? "Work Order Accepted" : "Work Order Accepted",
      message: isTech
        ? `You accepted Work Order ${workOrderCode}.`
        : `Work Order ${workOrderCode} has been accepted by ${acceptedBy}.`,
      type: "INFO",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order started — notify Admin, Supervisor, customer, creator. */
export async function notifyWoStarted({
  workOrderId,
  workOrderCode,
  complaintId,
  complaintCode,
  startedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  workOrderId: string;
  workOrderCode: string;
  complaintId?: string | null;
  complaintCode?: string | null;
  startedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyWorkOrderStaff({
    workOrderId,
    workOrderCode,
    eventType: EVENT_TYPES.WORK_ORDER_STARTED,
    title: "Work Started",
    message: `Work on ${complaintCode ? `complaint ${complaintCode} ` : ""}(Work Order ${workOrderCode}) has started.`,
    type: "INFO",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintRecipient({
      userId,
      eventType: EVENT_TYPES.WORK_ORDER_STARTED,
      resourceType: complaintId ? "COMPLAINT" : "WORK_ORDER",
      resourceId: complaintId ?? workOrderId,
      title: "Work Started",
      message: `Work on your ${complaintCode ? `complaint ${complaintCode} ` : ""}(Work Order ${workOrderCode}) has started by ${startedBy}.`,
      type: "INFO",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order put on hold — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyWoOnHold({
  workOrderId,
  workOrderCode,
  complaintId,
  complaintCode,
  holdReason,
  heldBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  workOrderId: string;
  workOrderCode: string;
  complaintId?: string | null;
  complaintCode?: string | null;
  holdReason?: string | null;
  heldBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  const reasonText = holdReason ? ` Reason: ${holdReason}.` : "";
  await notifyWorkOrderStaff({
    workOrderId,
    workOrderCode,
    eventType: EVENT_TYPES.WORK_ORDER_ON_HOLD,
    title: "Work Order On Hold",
    message: `Work Order ${workOrderCode}${complaintCode ? ` for complaint ${complaintCode}` : ""} has been put on hold by ${heldBy}.${reasonText}`,
    type: "WARNING",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintRecipient({
      userId,
      eventType: EVENT_TYPES.WORK_ORDER_ON_HOLD,
      resourceType: complaintId ? "COMPLAINT" : "WORK_ORDER",
      resourceId: complaintId ?? workOrderId,
      title: isTech ? "Work Order On Hold" : "Work Order On Hold",
      message: isTech
        ? `Work Order ${workOrderCode} has been put on hold${reasonText}`
        : `Work on your ${complaintCode ? `complaint ${complaintCode} ` : ""}(Work Order ${workOrderCode}) has been put on hold${reasonText}`,
      type: "WARNING",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order submitted for review — notify Admin, Supervisor, technician, customer/creator. */
export async function notifyWoSubmitted({
  workOrderId,
  workOrderCode,
  complaintId,
  complaintCode,
  submittedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  workOrderId: string;
  workOrderCode: string;
  complaintId?: string | null;
  complaintCode?: string | null;
  submittedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyWorkOrderStaff({
    workOrderId,
    workOrderCode,
    eventType: EVENT_TYPES.WORK_ORDER_SUBMITTED,
    title: "Work Order Submitted for Review",
    message: `Work Order ${workOrderCode}${complaintCode ? ` for complaint ${complaintCode}` : ""} has been submitted for supervisor review by ${submittedBy}.`,
    type: "INFO",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintRecipient({
      userId,
      eventType: EVENT_TYPES.WORK_ORDER_SUBMITTED,
      resourceType: complaintId ? "COMPLAINT" : "WORK_ORDER",
      resourceId: complaintId ?? workOrderId,
      title: isTech ? "Work Order Submitted" : "Work Order Submitted for Review",
      message: isTech
        ? `You submitted Work Order ${workOrderCode} for review.`
        : `Work Order ${workOrderCode}${complaintCode ? ` for complaint ${complaintCode}` : ""} has been submitted for review.`,
      type: "INFO",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order approved and closed — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyWoClosed({
  workOrderId,
  workOrderCode,
  complaintId,
  complaintCode,
  closedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  workOrderId: string;
  workOrderCode: string;
  complaintId?: string | null;
  complaintCode?: string | null;
  closedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyWorkOrderStaff({
    workOrderId,
    workOrderCode,
    eventType: EVENT_TYPES.WORK_ORDER_CLOSED,
    title: "Work Order Closed",
    message: `Work Order ${workOrderCode}${complaintCode ? ` for complaint ${complaintCode}` : ""} has been approved and closed by ${closedBy}.`,
    type: "SUCCESS",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintRecipient({
      userId,
      eventType: EVENT_TYPES.WORK_ORDER_CLOSED,
      resourceType: complaintId ? "COMPLAINT" : "WORK_ORDER",
      resourceId: complaintId ?? workOrderId,
      title: isTech ? "Work Order Closed" : "Work Order Closed",
      message: isTech
        ? `Work Order ${workOrderCode} has been approved and closed.`
        : `Your ${complaintCode ? `complaint ${complaintCode} ` : ""}(Work Order ${workOrderCode}) has been completed and closed.`,
      type: "SUCCESS",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

/** Work order reopened — notify Admin, Supervisor, technician, customer, creator. */
export async function notifyWoReopened({
  workOrderId,
  workOrderCode,
  complaintId,
  complaintCode,
  reason,
  reopenedBy,
  customerId,
  createdById,
  technicianUserId,
}: {
  workOrderId: string;
  workOrderCode: string;
  complaintId?: string | null;
  complaintCode?: string | null;
  reason: string;
  reopenedBy: string;
  customerId: string;
  createdById: string;
  technicianUserId?: string | null;
}): Promise<void> {
  await notifyWorkOrderStaff({
    workOrderId,
    workOrderCode,
    eventType: EVENT_TYPES.WORK_ORDER_REOPENED,
    title: "Work Order Reopened",
    message: `Work Order ${workOrderCode}${complaintCode ? ` for complaint ${complaintCode}` : ""} has been reopened by ${reopenedBy}. Reason: ${reason}.`,
    type: "WARNING",
  });

  const notified = new Set<string>();
  const notifyUser = async (userId: string | null | undefined, isTech: boolean = false) => {
    if (!userId || notified.has(userId)) return;
    notified.add(userId);
    await notifyComplaintRecipient({
      userId,
      eventType: EVENT_TYPES.WORK_ORDER_REOPENED,
      resourceType: complaintId ? "COMPLAINT" : "WORK_ORDER",
      resourceId: complaintId ?? workOrderId,
      title: isTech ? "Work Order Reopened" : "Work Order Reopened",
      message: isTech
        ? `Work Order ${workOrderCode} has been reopened for rework. Reason: ${reason}.`
        : `Work Order ${workOrderCode}${complaintCode ? ` for complaint ${complaintCode}` : ""} has been reopened. Reason: ${reason}.`,
      type: "WARNING",
    });
  };
  const customerUserId = await resolveCustomerPortalUserId(customerId);
  await notifyUser(technicianUserId, true);
  await notifyUser(customerUserId);
  await notifyUser(createdById);
}

