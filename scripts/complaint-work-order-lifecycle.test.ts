// MOHD.HMS ENTERPRISE — Complaint ↔ Work Order lifecycle self-check.
// Runs against the real schema inside a transaction that is ALWAYS rolled back,
// so it verifies the DB transitions without leaving test data behind.
//
//   bun --conditions=react-server scripts/complaint-work-order-lifecycle.test.ts
//
// `react-server` neutralizes the `server-only` guard that protects the API
// error type used by the lifecycle helpers.

import { db } from "@/lib/db";
import { WO_TRANSITIONS } from "@/lib/hms/constants";
import {
  ACTIVE_WO_STATUSES,
  complaintStatusForWorkOrder,
  lockComplaintToWorkOrder,
  syncComplaintFromWorkOrder,
  reopenComplaintFromWorkOrder,
  assertComplaintNotControlledByWorkOrder,
} from "@/lib/hms/workflows/complaint-work-order";

function eq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}
function ok(value: unknown, label: string) {
  if (!value) throw new Error(`${label}: expected truthy`);
}
function throws(fn: () => void, contains: string, label: string) {
  try {
    fn();
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes(contains)) throw new Error(`${label}: wrong error "${msg}"`);
    return;
  }
  throw new Error(`${label}: expected an error`);
}

// ── Pure lifecycle rules (no DB) ──
eq(complaintStatusForWorkOrder("PENDING"), "ASSIGNED", "PENDING maps to ASSIGNED");
eq(complaintStatusForWorkOrder("ACCEPTED"), "ASSIGNED", "ACCEPTED maps to ASSIGNED");
eq(complaintStatusForWorkOrder("IN_PROGRESS"), "IN_PROGRESS", "IN_PROGRESS maps to IN_PROGRESS");
eq(complaintStatusForWorkOrder("ON_HOLD"), "IN_PROGRESS", "ON_HOLD maps to IN_PROGRESS");
eq(complaintStatusForWorkOrder("COMPLETED"), "COMPLETED", "COMPLETED = submitted for review");
eq(complaintStatusForWorkOrder("CLOSED"), "CLOSED", "CLOSED closes the complaint");
eq(complaintStatusForWorkOrder("CANCELLED"), null, "CANCELLED does not cascade");

ok(ACTIVE_WO_STATUSES.includes("COMPLETED"), "COMPLETED still locks the complaint");
eq(WO_TRANSITIONS.COMPLETED.join(","), "CLOSED,IN_PROGRESS", "COMPLETED may close or be returned to IN_PROGRESS for rework");
eq(WO_TRANSITIONS.CLOSED.join(","), "IN_PROGRESS", "CLOSED may only reopen");
eq(WO_TRANSITIONS.IN_PROGRESS.includes("COMPLETED"), true, "IN_PROGRESS may submit");

throws(
  () => assertComplaintNotControlledByWorkOrder({ workOrders: [{ code: "WO-QA", status: "COMPLETED" }] }, "complete"),
  "controlled by its linked Work Order",
  "manual complete blocked while awaiting review",
);
throws(
  () => assertComplaintNotControlledByWorkOrder({ workOrders: [{ code: "WO-QA", status: "CLOSED" }] }, "cancel"),
  "Cancellation blocked",
  "cancel blocked after closure",
);
throws(
  () => assertComplaintNotControlledByWorkOrder({ workOrders: [{ code: "WO-QA", status: "IN_PROGRESS" }] }, "edit"),
  "locked by linked Work Order",
  "edit blocked while linked",
);
assertComplaintNotControlledByWorkOrder({ workOrders: [{ code: "WO-QA", status: "CANCELLED" }] }, "cancel");
assertComplaintNotControlledByWorkOrder({ workOrders: [] }, "complete");
throws(
  () => assertComplaintNotControlledByWorkOrder({ lockedAt: new Date(), workOrders: [] }, "edit"),
  "locked",
  "legacy locked complaint remains read-only",
);

// ── DB transitions (rolled back) ──
class Rollback extends Error {}
const ROLLBACK = new Rollback("rollback");

async function main() {
  let scenario = "";
  let checked = 0;
  try {
    await db.$transaction(async (tx) => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const customer = await tx.customer.create({
        data: { code: `QA-${stamp}`, companyName: "QA Lifecycle", contactPerson: "QA", email: `qa-${stamp}@example.invalid` },
        select: { id: true },
      });
      const complaint = await tx.complaint.create({
        data: {
          code: `CPT-QA-${stamp}`,
          customerId: customer.id,
          title: "QA complaint",
          description: "Lifecycle self-check",
          status: "ASSIGNED",
          lockedAt: null,
        },
        select: { id: true, status: true },
      });
      const wo = await tx.workOrder.create({
        data: {
          code: `WO-QA-${stamp}`,
          complaintId: complaint.id,
          customerId: customer.id,
          title: "QA work order",
          sourceType: "COMPLAINT",
          status: "PENDING",
        },
        select: { id: true },
      });

      // Creation locks the complaint; repeated locking is idempotent.
      const lock1 = await lockComplaintToWorkOrder(tx, { complaintId: complaint.id, workOrderId: wo.id });
      eq(lock1?.alreadyLocked, false, "first link locks");
      const lock2 = await lockComplaintToWorkOrder(tx, { complaintId: complaint.id, workOrderId: wo.id });
      eq(lock2?.alreadyLocked, true, "second link is idempotent");
      const locked = await tx.complaint.findUniqueOrThrow({ where: { id: complaint.id }, select: { lockedAt: true } });
      ok(locked.lockedAt, "lockedAt persisted");

      // PENDING does not regress an already ASSIGNED complaint.
      eq(await syncComplaintFromWorkOrder(tx, { workOrderId: wo.id, changedById: "qa" }), null, "PENDING sync is a no-op");

      await tx.workOrder.update({ where: { id: wo.id }, data: { status: "IN_PROGRESS" } });
      const started = await syncComplaintFromWorkOrder(tx, { workOrderId: wo.id, changedById: "qa", note: "started" });
      eq(started?.toStatus, "IN_PROGRESS", "start sync advances complaint");
      eq((await tx.complaint.findUniqueOrThrow({ where: { id: complaint.id }, select: { status: true } })).status, "IN_PROGRESS", "complaint in progress");

      // ON_HOLD never regresses the complaint.
      await tx.workOrder.update({ where: { id: wo.id }, data: { status: "ON_HOLD" } });
      eq(await syncComplaintFromWorkOrder(tx, { workOrderId: wo.id, changedById: "qa" }), null, "ON_HOLD sync is a no-op");

      // Technician submission: complaint is COMPLETED, NOT closed, no invoice trigger.
      await tx.workOrder.update({ where: { id: wo.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      const submitted = await syncComplaintFromWorkOrder(tx, { workOrderId: wo.id, changedById: "qa", note: "submitted" });
      eq(submitted?.toStatus, "COMPLETED", "submission sync sets COMPLETED");
      const afterSubmit = await tx.complaint.findUniqueOrThrow({
        where: { id: complaint.id },
        select: { status: true, closedAt: true, closureSource: true, closedByWorkOrderId: true },
      });
      eq(afterSubmit.status, "COMPLETED", "complaint pending review");
      eq(afterSubmit.closedAt, null, "complaint not closed before approval");
      eq(afterSubmit.closureSource, "", "no closure source before approval");
      eq(afterSubmit.closedByWorkOrderId, null, "no closing work order before approval");
      scenario = "submitted";
      checked++;

      // Supervisor approval/closure: complaint closes and records its source.
      await tx.workOrder.update({ where: { id: wo.id }, data: { status: "CLOSED", closedAt: new Date(), approvedAt: new Date(), approvedById: "qa" } });
      const closed = await syncComplaintFromWorkOrder(tx, { workOrderId: wo.id, changedById: "qa", note: "approved" });
      eq(closed?.toStatus, "CLOSED", "closure sync closes complaint");
      const afterClose = await tx.complaint.findUniqueOrThrow({
        where: { id: complaint.id },
        select: { status: true, closedAt: true, closureSource: true, closedByWorkOrderId: true },
      });
      eq(afterClose.status, "CLOSED", "complaint closed");
      ok(afterClose.closedAt, "closedAt persisted");
      eq(afterClose.closureSource, "WORK_ORDER", "closure source recorded");
      eq(afterClose.closedByWorkOrderId, wo.id, "closing work order recorded");
      scenario = "closed";
      checked++;

      const historyBefore = await tx.complaintStatusHistory.count({ where: { complaintId: complaint.id } });
      eq(await syncComplaintFromWorkOrder(tx, { workOrderId: wo.id, changedById: "qa" }), null, "repeated closure is idempotent");
      eq(await tx.complaintStatusHistory.count({ where: { complaintId: complaint.id } }), historyBefore, "no duplicate history");

      // Supervisor reopen cascades the complaint back to IN_PROGRESS.
      await tx.workOrder.update({ where: { id: wo.id }, data: { status: "IN_PROGRESS", completedAt: null, closedAt: null, approvedAt: null, approvedById: null } });
      const reopened = await reopenComplaintFromWorkOrder(tx, { workOrderId: wo.id, changedById: "qa", reason: "Rework needed" });
      eq(reopened?.toStatus, "IN_PROGRESS", "reopen reopens complaint");
      const afterReopen = await tx.complaint.findUniqueOrThrow({
        where: { id: complaint.id },
        select: { status: true, closedAt: true, closureSource: true, closedByWorkOrderId: true },
      });
      eq(afterReopen.status, "IN_PROGRESS", "complaint reopened");
      eq(afterReopen.closedAt, null, "closedAt cleared");
      eq(afterReopen.closureSource, "", "closure source cleared");
      eq(afterReopen.closedByWorkOrderId, null, "closing work order cleared");
      scenario = "reopened";
      checked++;

      // A cancelled complaint is never auto-revived.
      const cancelled = await tx.complaint.create({
        data: { code: `CPT-QA-C-${stamp}`, customerId: customer.id, title: "Cancelled", description: "x", status: "CANCELLED" },
        select: { id: true },
      });
      const cancelledWo = await tx.workOrder.create({
        data: { code: `WO-QA-C-${stamp}`, complaintId: cancelled.id, customerId: customer.id, title: "Cancelled WO", sourceType: "COMPLAINT", status: "IN_PROGRESS" },
        select: { id: true },
      });
      eq(await syncComplaintFromWorkOrder(tx, { workOrderId: cancelledWo.id, changedById: "qa" }), null, "cancelled complaint is not revived");
      eq((await tx.complaint.findUniqueOrThrow({ where: { id: cancelled.id }, select: { status: true } })).status, "CANCELLED", "cancelled stays cancelled");
      scenario = "cancelled complaint";
      checked++;

      // A complaint whose only work order was cancelled is manually cancellable.
      const free = await tx.complaint.create({
        data: { code: `CPT-QA-F-${stamp}`, customerId: customer.id, title: "Free", description: "x", status: "ASSIGNED" },
        select: { id: true },
      });
      await tx.workOrder.create({
        data: { code: `WO-QA-F-${stamp}`, complaintId: free.id, customerId: customer.id, title: "Cancelled WO", sourceType: "COMPLAINT", status: "CANCELLED" },
      });
      assertComplaintNotControlledByWorkOrder({ workOrders: [{ code: "WO-QA-F", status: "CANCELLED" }] }, "cancel");
      scenario = "cancelled work order";
      checked++;

      throw ROLLBACK;
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(`PASS — complaint/work-order lifecycle (${checked} DB scenarios + pure rules), transaction rolled back`);
}

void main().catch((e) => {
  console.error("FAIL —", e);
  process.exit(1);
});
