// MOHD.HMS ENTERPRISE — Complaint ↔ Work Order lifecycle synchronization.
//
// A Work Order that was created from a Complaint is the AUTHORITATIVE
// controller of that Complaint's lifecycle. The complaint's own status is
// therefore derived from its linked work order and must never drift into a
// contradictory pair (backend-authoritative — direct API calls are blocked
// just like the UI).
//
// Existing status vocabularies are reused verbatim (no duplicate definitions):
//   Work order:  PENDING → ACCEPTED → IN_PROGRESS → COMPLETED → CLOSED (+ON_HOLD, CANCELLED)
//   Complaint:   NEW → ASSIGNED → IN_PROGRESS → COMPLETED → CONFIRMED → CLOSED (+CANCELLED)
// COMPLETED means "technician submitted, awaiting supervisor review"; CLOSED is
// the only final successful work-order state and is what closes the complaint.
// The complaint has no separate "pending review" state, so COMPLETED is its
// nearest existing equivalent until the work order is finally CLOSED.

import { Errors } from "@/lib/hms/api";
import type { Prisma } from "@prisma/client";

export type Tx = Prisma.TransactionClient;

/** Work-order statuses that keep a linked complaint locked (unsettled). */
export const ACTIVE_WO_STATUSES = ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED"] as const;

/** Monotonic progress order — a forward sync may advance a complaint, never regress it. */
const COMPLAINT_RANK: Record<string, number> = {
  NEW: 0,
  ASSIGNED: 1,
  IN_PROGRESS: 2,
  COMPLETED: 3,
  CONFIRMED: 4,
  CLOSED: 5,
};

/**
 * Canonical mapping: the complaint state a given work-order status requires.
 * `null` means "leave the complaint alone" (a cancelled work order does not
 * silently resolve the complaint — an authorized supervisor decides that).
 */
export function complaintStatusForWorkOrder(woStatus: string): string | null {
  switch (woStatus) {
    case "PENDING":
    case "ACCEPTED":
      return "ASSIGNED";
    case "IN_PROGRESS":
    case "ON_HOLD":
      // The complaint vocabulary has no ON_HOLD; active work stays IN_PROGRESS.
      return "IN_PROGRESS";
    case "COMPLETED":
      // Submitted for review — existing complaint status closest to "pending review".
      return "COMPLETED";
    case "CLOSED":
      return "CLOSED";
    default:
      return null;
  }
}

export interface ComplaintSyncResult {
  id: string;
  code: string;
  fromStatus: string;
  toStatus: string;
  workOrderCode: string;
}

/**
 * Lock a complaint to its work order. Idempotent: the first link stamps
 * `lockedAt`; repeated calls (retries, duplicate creation events) change nothing.
 */
export async function lockComplaintToWorkOrder(
  tx: Tx,
  args: { complaintId: string; workOrderId: string },
): Promise<{ id: string; code: string; alreadyLocked: boolean } | null> {
  const complaint = await tx.complaint.findUnique({
    where: { id: args.complaintId },
    select: { id: true, code: true, lockedAt: true },
  });
  if (!complaint) return null;
  if (complaint.lockedAt) return { id: complaint.id, code: complaint.code, alreadyLocked: true };
  await tx.complaint.update({ where: { id: complaint.id }, data: { lockedAt: new Date() } });
  return { id: complaint.id, code: complaint.code, alreadyLocked: false };
}

/**
 * Derive the linked complaint's status from the work order and apply it inside
 * the caller's transaction. Forward-only (a work order that regresses — e.g.
 * ON_HOLD — never pulls a started complaint backwards) and never touches a
 * CANCELLED complaint. CLOSED is delegated to closeComplaintFromWorkOrder so
 * closure always records its source and triggering work order.
 */
export async function syncComplaintFromWorkOrder(
  tx: Tx,
  args: { workOrderId: string; changedById: string; note?: string },
): Promise<ComplaintSyncResult | null> {
  const wo = await tx.workOrder.findUnique({
    where: { id: args.workOrderId },
    select: { id: true, complaintId: true, status: true, code: true },
  });
  if (!wo?.complaintId) return null;
  if (wo.status === "CLOSED") {
    return closeComplaintFromWorkOrder(tx, {
      workOrderId: wo.id,
      changedById: args.changedById,
      note: args.note,
    });
  }

  const complaint = await tx.complaint.findUnique({
    where: { id: wo.complaintId },
    select: { id: true, code: true, status: true, completedAt: true, lockedAt: true },
  });
  if (!complaint) return null;
  // A cancelled complaint is a closed business case — never auto-revive it.
  if (complaint.status === "CANCELLED") return null;

  const target = complaintStatusForWorkOrder(wo.status);
  if (!target) return null;

  const currentRank = COMPLAINT_RANK[complaint.status] ?? 0;
  const targetRank = COMPLAINT_RANK[target] ?? 0;
  if (targetRank <= currentRank) {
    // Still ensure a legacy linked complaint becomes locked even when its status
    // already matches the derived state.
    if (!complaint.lockedAt) await tx.complaint.update({ where: { id: complaint.id }, data: { lockedAt: new Date() } });
    return null;
  }

  const now = new Date();
  const stamps: Prisma.ComplaintUpdateInput = { lockedAt: complaint.lockedAt ?? now };
  if (target === "ASSIGNED") stamps.assignedAt = now;
  if (target === "IN_PROGRESS") {
    stamps.acceptedAt = now;
    stamps.startedAt = now;
  }
  if (target === "COMPLETED") {
    stamps.completedAt = complaint.completedAt ?? now;
  }

  await tx.complaint.update({ where: { id: complaint.id }, data: { status: target, ...stamps } });
  await tx.complaintStatusHistory.create({
    data: {
      complaintId: complaint.id,
      fromStatus: complaint.status,
      toStatus: target,
      changedById: args.changedById,
      note: args.note ?? `Synchronized from linked Work Order ${wo.code}`,
    },
  });
  return { id: complaint.id, code: complaint.code, fromStatus: complaint.status, toStatus: target, workOrderCode: wo.code };
}

/**
 * Final closure: only a work order already in CLOSED may call this. Idempotent
 * — a repeated closure for the same work order writes no duplicate history.
 */
export async function closeComplaintFromWorkOrder(
  tx: Tx,
  args: { workOrderId: string; changedById: string; note?: string },
): Promise<ComplaintSyncResult | null> {
  const wo = await tx.workOrder.findUnique({
    where: { id: args.workOrderId },
    select: { id: true, complaintId: true, status: true, code: true, notes: true, completedAt: true },
  });
  if (!wo?.complaintId || wo.status !== "CLOSED") return null;

  const complaint = await tx.complaint.findUnique({
    where: { id: wo.complaintId },
    select: {
      id: true, code: true, status: true, closedAt: true, completedAt: true,
      closedByWorkOrderId: true, resolutionNotes: true, lockedAt: true,
    },
  });
  if (!complaint) return null;
  // Cancellation is an authorized business decision — never overwrite it.
  if (complaint.status === "CANCELLED") return null;
  if (complaint.status === "CLOSED" && complaint.closedByWorkOrderId === wo.id) return null;

  const now = new Date();
  await tx.complaint.update({
    where: { id: complaint.id },
    data: {
      status: "CLOSED",
      closedAt: now,
      completedAt: complaint.completedAt ?? wo.completedAt ?? now,
      lockedAt: complaint.lockedAt ?? now,
      closureSource: "WORK_ORDER",
      closedByWorkOrderId: wo.id,
      ...(complaint.resolutionNotes.trim() === "" && wo.notes.trim() !== "" ? { resolutionNotes: wo.notes } : {}),
    },
  });
  await tx.complaintStatusHistory.create({
    data: {
      complaintId: complaint.id,
      fromStatus: complaint.status,
      toStatus: "CLOSED",
      changedById: args.changedById,
      note: args.note ?? `Automatically closed after linked Work Order ${wo.code} was approved and closed`,
    },
  });
  return {
    id: complaint.id,
    code: complaint.code,
    fromStatus: complaint.status,
    toStatus: "CLOSED",
    workOrderCode: wo.code,
  };
}

/**
 * Reopen a complaint because its linked work order was legitimately reopened.
 * Only a CLOSED complaint is revived; a CANCELLED complaint stays cancelled
 * (that is an authorized business decision, not an automatic cascade).
 */
export async function reopenComplaintFromWorkOrder(
  tx: Tx,
  args: { workOrderId: string; changedById: string; reason: string },
): Promise<ComplaintSyncResult | null> {
  const wo = await tx.workOrder.findUnique({
    where: { id: args.workOrderId },
    select: { id: true, complaintId: true, status: true, code: true },
  });
  if (!wo?.complaintId) return null;
  if (!["IN_PROGRESS", "ACCEPTED"].includes(wo.status)) return null;

  const complaint = await tx.complaint.findUnique({
    where: { id: wo.complaintId },
    select: { id: true, code: true, status: true },
  });
  if (!complaint || complaint.status !== "CLOSED") return null;

  await tx.complaint.update({
    where: { id: complaint.id },
    data: {
      status: "IN_PROGRESS",
      closedAt: null,
      completedAt: null,
      closureSource: "",
      closedByWorkOrderId: null,
    },
  });
  await tx.complaintStatusHistory.create({
    data: {
      complaintId: complaint.id,
      fromStatus: "CLOSED",
      toStatus: "IN_PROGRESS",
      changedById: args.changedById,
      note: `Automatically reopened because linked Work Order ${wo.code} was reopened: ${args.reason}`,
    },
  });
  return { id: complaint.id, code: complaint.code, fromStatus: "CLOSED", toStatus: "IN_PROGRESS", workOrderCode: wo.code };
}

export type ComplaintControlAction = "assign" | "accept" | "start" | "complete" | "confirm" | "close" | "cancel" | "edit";

/**
 * Backend guard: while a linked work order exists (and was not itself
 * cancelled), the complaint's manual transitions are locked — the work order
 * owns them. Cancellation stays locked until every linked work order is
 * CANCELLED, at which point the existing authorized cancellation flow applies.
 */
export function assertComplaintNotControlledByWorkOrder(
  complaint: { lockedAt?: Date | null; workOrders: { code: string; status: string }[] },
  action: ComplaintControlAction,
): void {
  const linked = complaint.workOrders.find((w) => w.status !== "CANCELLED");
  if (!linked) {
    if (action === "edit" && complaint.lockedAt) {
      throw Errors.invalidTransition("This complaint is locked and can no longer be edited.");
    }
    return;
  }
  const unsettled = (ACTIVE_WO_STATUSES as readonly string[]).includes(linked.status);

  if (action === "cancel") {
    throw Errors.invalidTransition(
      `Cancellation blocked. This complaint is controlled by linked Work Order ${linked.code}` +
        (unsettled ? " (still active)." : " (already settled)."),
    );
  }

  if (action === "edit") {
    throw Errors.invalidTransition(
      `This complaint is locked by linked Work Order ${linked.code}. Original complaint details are read-only.`,
    );
  }

  throw Errors.invalidTransition(
    `This complaint is controlled by its linked Work Order ${linked.code}` +
      (unsettled ? " (still active)." : " (already settled).") +
      " Its status is updated automatically by that work order.",
  );
}
