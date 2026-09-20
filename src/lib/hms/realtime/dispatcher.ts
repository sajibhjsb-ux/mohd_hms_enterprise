// MOHD.HMS ENTERPRISE — Realtime dispatcher (FULL REALTIME UPDATE SYSTEM).
// Reads the authoritative DomainEvent outbox and hands committed, un-broadcast
// events to the realtime service (socket.io mini service) which delivers them
// to authorized connected browsers.
//
// Guarantees (mapped to the realtime spec):
//   • Only events committed to the outbox are ever broadcast (STEP 3/4) — the
//     dispatcher never sees rows from rolled-back transactions.
//   • Audience is resolved SERVER-SIDE into room names (STEP 9) and rooms can
//     only contain sockets the service placed there from a verified session.
//   • At-least-once delivery: claim guard + fallback poller recover push
//     failures and missed events (STEP 6/22); clients are idempotent.
//   • The primary DB remains the source of truth; the realtime service keeps
//     NO business state and never touches the database (STEP 4/27).

import "server-only";
import { db } from "@/lib/db";
import { EVENT_TYPES } from "../workflows/types";

const SERVICE_URL = process.env.REALTIME_INTERNAL_URL ?? "http://127.0.0.1:3004";
const SECRET = process.env.REALTIME_INTERNAL_SECRET ?? "hms-realtime-internal-secret-v1";
/** Only (re)broadcast events from the last N minutes — an old un-broadcast row
 *  after a long outage is reconciled by refetch, not replayed to every client. */
const RECENT_WINDOW_MS = 10 * 60_000;
const BATCH = 50;

export type RealtimeEventRow = {
  id: string;
  type: string;
  resourceType: string;
  resourceId: string;
  payload: string;
  actorType: string;
  actorId: string | null;
  createdAt: Date;
};

type Room = string; // "user:{id}" | "role:{ROLE}" | "customer:{id}" | "staff" | "all"

const g = globalThis as unknown as {
  __hmsRealtimeDispatching?: boolean;
  __hmsRealtimeLastDispatchAt?: number;
  __hmsRealtimeLastError?: string;
  __hmsRealtimeLastBroadcastAt?: number;
};

export function dispatcherHealth() {
  return {
    lastDispatchAt: g.__hmsRealtimeLastDispatchAt ?? 0,
    lastBroadcastAt: g.__hmsRealtimeLastBroadcastAt ?? 0,
    lastError: g.__hmsRealtimeLastError ?? "",
    dispatching: !!g.__hmsRealtimeDispatching,
    serviceUrl: SERVICE_URL,
  };
}

// ─── Audience resolution (server-authoritative, STEP 9) ──────────────────────

// Audience vocabulary (STEP 9 — role-scoped delivery):
//   mgmt()        → operational management: ADMIN / SUPER_ADMIN / SUPERVISOR
//   financeAud()  → finance-facing: ADMIN / SUPER_ADMIN / FINANCE
//   hrAud()       → people ops: ADMIN / SUPER_ADMIN / HR
//   staffAll()    → genuinely staff-wide neutral events (user/customer records)
//   user(id)      → one exact user (e.g. the assigned technician)
//   customer(id)  → every portal user of that customer
// Technicians receive ONLY their own user-room events (own assignments,
// own notifications) — never unrelated customers' business data.
const mgmt = (): Room[] => ["role:ADMIN", "role:SUPER_ADMIN", "role:SUPERVISOR"];
const financeAud = (): Room[] => ["role:ADMIN", "role:SUPER_ADMIN", "role:FINANCE"];
const hrAud = (): Room[] => ["role:ADMIN", "role:SUPER_ADMIN", "role:HR"];
const staffAll = (): Room[] => ["staff"];
const user = (id: string | null | undefined): Room[] => (id ? [`user:${id}`] : []);
const customer = (id: string | null | undefined): Room[] => (id ? [`customer:${id}`] : []);

type ComplaintCtx = { customerId: string; technicianUserId: string | null } | null;

async function complaintCtx(complaintId: string): Promise<ComplaintCtx> {
  if (!complaintId) return null;
  const c = await db.complaint.findUnique({
    where: { id: complaintId },
    select: { customerId: true, assignedTechnician: { select: { userId: true } } },
  });
  return c ? { customerId: c.customerId, technicianUserId: c.assignedTechnician?.userId ?? null } : null;
}

type WoCtx = { customerId: string; technicianUserId: string | null } | null;

async function workOrderCtx(woId: string): Promise<WoCtx> {
  if (!woId) return null;
  const wo = await db.workOrder.findUnique({
    where: { id: woId },
    select: { customerId: true, technician: { select: { userId: true } } },
  });
  return wo ? { customerId: wo.customerId, technicianUserId: wo.technician?.userId ?? null } : null;
}

/** Inspection report audience context: owning customer (via project) + inspector user. */
type IrmsCtx = { customerId: string | null; inspectorUserId: string | null } | null;

async function inspectionCtx(reportId: string): Promise<IrmsCtx> {
  if (!reportId) return null;
  const r = await db.inspectionReport.findUnique({
    where: { id: reportId },
    select: {
      customerVisible: true,
      project: { select: { customerId: true } },
      inspector: { select: { userId: true } },
    },
  });
  return r
    ? { customerId: r.customerVisible ? r.project.customerId : null, inspectorUserId: r.inspector?.userId ?? null }
    : null;
}

/**
 * Map an outbox event to the rooms that should receive it.
 * Unknown event types default to `staff` (fail-closed: never broadcast business
 * data to customers without an explicit rule here).
 */
export async function resolveRooms(event: RealtimeEventRow): Promise<Room[]> {
  const t = event.type;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(event.payload || "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }

  // Internal email pipeline — never broadcast (STEP 9: no sensitive leakage).
  if (t === EVENT_TYPES.EMAIL_SEND) return [];

  // Notifications → exactly the targeted users (STEP 17).
  if (t === EVENT_TYPES.NOTIFICATION_CREATED) {
    const userIds = Array.isArray(payload.userIds) ? (payload.userIds as string[]) : [];
    return userIds.flatMap((id) => user(id));
  }

  switch (t) {
    // ── Complaint lifecycle (STEP 38-42): staff + owning customer; the
    //    assigned technician also follows accept/start/complete progress.
    case EVENT_TYPES.COMPLAINT_CREATED:
    case EVENT_TYPES.COMPLAINT_UPDATED: {
      const ctx = await complaintCtx(event.resourceId);
      return [...mgmt(), ...customer(ctx?.customerId)];
    }
    case EVENT_TYPES.COMPLAINT_ASSIGNED: {
      const ctx = await complaintCtx(event.resourceId);
      return [...mgmt(), ...customer(ctx?.customerId), ...user(ctx?.technicianUserId)];
    }
    case EVENT_TYPES.COMPLAINT_ACCEPTED:
    case EVENT_TYPES.COMPLAINT_STARTED:
    case EVENT_TYPES.COMPLAINT_COMPLETED: {
      const ctx = await complaintCtx(event.resourceId);
      return [...mgmt(), ...customer(ctx?.customerId), ...user(ctx?.technicianUserId)];
    }
    case EVENT_TYPES.COMPLAINT_CONFIRMED:
    case EVENT_TYPES.COMPLAINT_CLOSED: {
      const ctx = await complaintCtx(event.resourceId);
      return [...mgmt(), ...customer(ctx?.customerId)];
    }
    case EVENT_TYPES.ESCALATE_COMPLAINT_NOT_ACCEPTED:
    case EVENT_TYPES.SLA_BREACH_COMPLAINT:
      return mgmt();

    // ── Work orders (STEP 13/39-42): staff + customer + assigned technician.
    case EVENT_TYPES.WORK_ORDER_CREATED:
    case EVENT_TYPES.WORK_ORDER_UPDATED:
    case EVENT_TYPES.WORK_ORDER_COMPLETED:
    case EVENT_TYPES.WO_OVERDUE: {
      const woId = t === EVENT_TYPES.WORK_ORDER_COMPLETED ? String(payload.workOrderId ?? event.resourceId) : event.resourceId;
      const ctx = await workOrderCtx(woId);
      return [...mgmt(), ...customer(ctx?.customerId), ...user(ctx?.technicianUserId)];
    }
    case EVENT_TYPES.COMPLAINT_ACCEPTANCE_AUTO_WO: {
      const ctx = await workOrderCtx(String(payload.workOrderId ?? ""));
      return ctx ? [...mgmt(), ...customer(ctx.customerId), ...user(ctx.technicianUserId)] : mgmt();
    }

    // ── Finance (STEP 14): staff + owning customer only.
    case EVENT_TYPES.INVOICE_CREATED:
    case EVENT_TYPES.INVOICE_UPDATED:
    case EVENT_TYPES.INVOICE_SENT:
    case EVENT_TYPES.INVOICE_OVERDUE:
    case EVENT_TYPES.PAYMENT_RECEIVED: {
      if (event.resourceType === "INVOICE" && event.resourceId) {
        const inv = await db.invoice.findUnique({ where: { id: event.resourceId }, select: { customerId: true } });
        return [...financeAud(), ...customer(inv?.customerId)];
      }
      return financeAud();
    }

    // ── Quotations (STEP 10: customer sees sent quotations).
    case EVENT_TYPES.QUOTATION_CREATED:
    case EVENT_TYPES.QUOTATION_UPDATED:
    case EVENT_TYPES.QUOTATION_SENT:
    case EVENT_TYPES.QUOTATION_ACCEPTED: {
      if (event.resourceId) {
        const q = await db.quotation.findUnique({ where: { id: event.resourceId }, select: { customerId: true } });
        return [[...mgmt(), ...financeAud()].filter((r, i, a) => a.indexOf(r) === i), ...customer(q?.customerId)].flat();
      }
      return [...mgmt(), ...financeAud()];
    }

    // ── Inventory / purchasing (STEP 15): staff only.
    case EVENT_TYPES.LOW_STOCK:
    case EVENT_TYPES.INVENTORY_ADJUSTED:
    case EVENT_TYPES.INVENTORY_ITEM_UPDATED:
    case EVENT_TYPES.SUPPLIER_UPDATED:
    case EVENT_TYPES.PURCHASE_CREATED:
    case EVENT_TYPES.PURCHASE_UPDATED:
    case EVENT_TYPES.PURCHASE_RECEIVED:
      return mgmt();

    // ── PM (STEP 12): staff only.
    case EVENT_TYPES.PM_DUE:
    case EVENT_TYPES.PM_REMINDER:
    case EVENT_TYPES.PM_OVERDUE:
    case EVENT_TYPES.PM_PLAN_UPDATED:
    case EVENT_TYPES.PM_TASK_UPDATED:
      return mgmt();

    // ── IRMS: staff management + the assigned inspector; customers receive
    //    only APPROVED events for reports explicitly marked customer-visible.
    case EVENT_TYPES.IRMS_PROJECT_UPDATED:
    case EVENT_TYPES.IRMS_REPORT_UPDATED:
    case EVENT_TYPES.IRMS_PHOTOS_UPDATED:
    case EVENT_TYPES.INSPECTION_SUBMITTED:
    case EVENT_TYPES.INSPECTION_REVIEWED:
    case EVENT_TYPES.INSPECTION_REJECTED:
    case EVENT_TYPES.INSPECTION_ARCHIVED:
    case EVENT_TYPES.INSPECTION_COMPLETED: {
      const ctx = await inspectionCtx(event.resourceId);
      return [...mgmt(), ...user(ctx?.inspectorUserId)];
    }
    case EVENT_TYPES.INSPECTION_APPROVED: {
      const ctx = await inspectionCtx(event.resourceId);
      return [...mgmt(), ...user(ctx?.inspectorUserId), ...customer(ctx?.customerId)];
    }

    // ── HR / users / vehicles (STEP 10-18 matrix): staff only.
    case EVENT_TYPES.HR_LEAVE_UPDATED:
    case EVENT_TYPES.EMPLOYEE_UPDATED:
      return [...hrAud(), ...mgmt()].filter((r, i, a) => a.indexOf(r) === i);
    case EVENT_TYPES.VEHICLE_UPDATED:
      return mgmt();
    case EVENT_TYPES.USER_UPDATED:
      return [...staffAll(), ...user(event.resourceId)];

    // ── Checklist engine (AI checklist spec): instance events follow their
    //    work order (customer + assigned technician); complaint-draft events
    //    reach the owning customer's rooms. Fail-closed otherwise.
    case EVENT_TYPES.CHECKLIST_GENERATED:
    case EVENT_TYPES.CHECKLIST_UPDATED:
    case EVENT_TYPES.CHECKLIST_COMPLETED: {
      if (event.resourceType !== "CHECKLIST_INSTANCE" || !event.resourceId) return mgmt();
      const inst = await db.checklistInstance.findUnique({
        where: { id: event.resourceId },
        select: { workOrderId: true, sourceType: true, sourceId: true, customerId: true },
      });
      if (!inst) return mgmt();
      if (inst.workOrderId) {
        const ctx = await workOrderCtx(inst.workOrderId);
        return [...mgmt(), ...customer(ctx?.customerId), ...user(ctx?.technicianUserId)];
      }
      if (inst.sourceType === "COMPLAINT") {
        const ctx = await complaintCtx(inst.sourceId);
        return [...mgmt(), ...customer(ctx?.customerId)];
      }
      return mgmt();
    }

    // ── Equipment (STEP 10: customer's equipment service updates).
    case EVENT_TYPES.EQUIPMENT_UPDATED: {
      if (event.resourceId) {
        const eq = await db.equipment.findUnique({ where: { id: event.resourceId }, select: { customerId: true } });
        return [...mgmt(), ...customer(eq?.customerId)];
      }
      return mgmt();
    }

    // ── Customers (STEP 11): staff + that customer's own users.
    case EVENT_TYPES.CUSTOMER_UPDATED:
      return [...staffAll(), ...customer(event.resourceId)];

    default:
      // Fail closed: unknown/new event types reach management only —
      // never technicians or customers without an explicit rule.
      return mgmt();
  }
}

// ─── Dispatch loop ───────────────────────────────────────────────────────────

async function postToService(event: RealtimeEventRow, rooms: Room[]): Promise<void> {
  const envelope = {
    event_id: event.id,
    event_type: event.type,
    version: 1,
    aggregate_type: event.resourceType,
    aggregate_id: event.resourceId,
    timestamp: event.createdAt.toISOString(),
    actor: { user_id: event.actorId, type: event.actorType },
    data: safePayload(event.payload),
    rooms,
  };
  const res = await fetch(`${SERVICE_URL}/internal/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-realtime-secret": SECRET },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`realtime-publish-${res.status}`);
}

function safePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Broadcast all committed-but-un-broadcast recent outbox events.
 * Claim guard (broadcastAt CAS) keeps this safe across ticks and processes.
 */
export async function dispatchPendingEvents(): Promise<number> {
  if (g.__hmsRealtimeDispatching) return 0;
  g.__hmsRealtimeDispatching = true;
  let sent = 0;
  try {
    const candidates = await db.domainEvent.findMany({
      where: { broadcastAt: null, createdAt: { gte: new Date(Date.now() - RECENT_WINDOW_MS) } },
      orderBy: { createdAt: "asc" },
      take: BATCH,
      select: { id: true, type: true, resourceType: true, resourceId: true, payload: true, actorType: true, actorId: true, createdAt: true },
    });
    for (const event of candidates) {
      const claim = await db.domainEvent.updateMany({
        where: { id: event.id, broadcastAt: null },
        data: { broadcastAt: new Date() },
      });
      if (claim.count !== 1) continue; // another dispatcher claimed it
      try {
        const rooms = await resolveRooms(event);
        if (rooms.length) {
          await postToService(event, rooms);
          sent++;
          g.__hmsRealtimeLastBroadcastAt = Date.now();
          g.__hmsRealtimeLastError = "";
        }
      } catch (e) {
        // Release the claim so the next tick retries (STEP 22 recovery).
        g.__hmsRealtimeLastError = e instanceof Error ? e.message : String(e);
        await db.domainEvent.updateMany({ where: { id: event.id, broadcastAt: { not: null } }, data: { broadcastAt: null } }).catch(() => undefined);
        break; // service likely down — stop hammering, retry next tick
      }
    }
    g.__hmsRealtimeLastDispatchAt = Date.now();
  } catch (e) {
    g.__hmsRealtimeLastError = e instanceof Error ? e.message : String(e);
  } finally {
    g.__hmsRealtimeDispatching = false;
  }
  return sent;
}

/** Fire-and-forget dispatch kick (never blocks or fails the business request).
 *  Retries shortly after: a kick from inside an open transaction races the
 *  commit — the later attempts see the committed row; the 2s scheduler tick is
 *  the guaranteed safety net either way. */
export function kickRealtimeDispatch(): void {
  if (typeof setImmediate !== "function") return;
  const delays = [0, 400, 1200];
  for (const d of delays) {
    (d === 0 ? setImmediate : (fn: () => void) => setTimeout(fn, d))(() => {
      dispatchPendingEvents().catch(() => undefined);
    });
  }
}
