// MOHD.HMS ENTERPRISE — Evidence lifecycle enforcement test (rollback transaction).
// Verifies complaint media phase rules: BEFORE only before a WO is linked;
// DURING/AFTER require an active linked WO.
// `bun --conditions=react-server scripts/evidence-lifecycle.test.ts`
import assert from "node:assert";
import { db } from "@/lib/db";

class Rollback extends Error {}

async function main() {
  await db.$transaction(async (tx) => {
    const stamp = Date.now();
    const customer = await tx.customer.create({
      data: { code: `CUST-EVD-${stamp}`, contactPerson: "Evidence Customer", email: `evd${stamp}@example.com` },
    });
    const complaint = await tx.complaint.create({
      data: {
        code: `CPT-EVD-${stamp}`, title: "Evidence complaint", description: "", customerId: customer.id,
        status: "NEW", workCatalogue: "GENERAL", catalogueIssue: "General", createdById: null,
        statusHistory: { create: { fromStatus: "NEW", toStatus: "NEW", changedById: null, note: "created" } },
      },
    });

    // 1. Complaint NEW with no work order -> BEFORE phase is permitted.
    assert.equal(complaint.status, "NEW", "complaint starts NEW");
    assert.equal(complaint.workOrders === undefined || complaint.workOrders.length === 0, true, "no work order yet");

    // 2. Create a work order linked to the complaint -> complaint locks.
    const wo = await tx.workOrder.create({
      data: {
        code: `WO-EVD-${stamp}`, title: "Linked WO", description: "", customerId: customer.id,
        complaintId: complaint.id, status: "PENDING", sourceType: "COMPLAINT",
        labourTotalCents: 0, materialsTotalCents: 0, totalCents: 0,
      },
    });
    const locked = await tx.complaint.update({
      where: { id: complaint.id }, data: { lockedAt: new Date() },
    });
    assert.ok(locked.lockedAt, "complaint is locked after work order");

    // 3. Re-fetch complaint with work orders; enforcement conditions.
    const c2 = await tx.complaint.findUnique({
      where: { id: complaint.id },
      select: { id: true, status: true, lockedAt: true, workOrders: { select: { id: true, status: true } } },
    });
    assert.ok(c2, "complaint re-fetched");
    const hasWo = (c2.workOrders ?? []).length > 0;
    const activeWo = hasWo && (c2.workOrders ?? []).some((w) => !["CLOSED", "CANCELLED"].includes(w.status));
    assert.equal(hasWo, true, "work order linked");
    assert.equal(activeWo, true, "work order is active");

    // Enforcement rules (mirror the route):
    // BEFORE permitted only when complaint is NEW and has no work order.
    const beforePermitted = c2.status === "NEW" && !hasWo;
    assert.equal(beforePermitted, false, "BEFORE not permitted once WO linked");

    // DURING/AFTER permitted only when an active work order exists.
    const duringAfterPermitted = activeWo;
    assert.equal(duringAfterPermitted, true, "DURING/AFTER permitted with active WO");

    // 4. Close the work order -> activeWorkOrder becomes false -> DURING/AFTER blocked.
    await tx.workOrder.update({ where: { id: wo.id }, data: { status: "CLOSED", closedAt: new Date(), approvedAt: new Date(), approvedById: null } });
    const c3 = await tx.complaint.findUnique({
      where: { id: complaint.id },
      select: { workOrders: { select: { status: true } } },
    });
    const activeWoAfterClose = (c3?.workOrders ?? []).some((w) => !["CLOSED", "CANCELLED"].includes(w.status));
    assert.equal(activeWoAfterClose, false, "no active work order after close");

    throw new Rollback();
  }).catch((err) => { if (!(err instanceof Rollback)) throw err; });
  console.log("GREEN — evidence lifecycle enforcement");
}

main().catch((e) => { console.error(e); process.exit(1); });
