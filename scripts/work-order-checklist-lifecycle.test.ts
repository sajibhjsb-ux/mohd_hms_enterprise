// MOHD.HMS ENTERPRISE — Work Order checklist lifecycle verification.
// Runs inside a Prisma rollback transaction so the live DB is never polluted.
// `bun --conditions=react-server scripts/work-order-checklist-lifecycle.test.ts`
import assert from "node:assert";
import { db } from "@/lib/db";
import { audit, notifyRole } from "@/lib/hms/services";
import {
  canonicalizeCategory,
  inferCategory,
  inferWorkType,
  type ChecklistContext,
} from "@/lib/hms/checklist/context";
import {
  validateChecklistForSubmission,
  type ChecklistExecutionItem,
  resolveChecklistItemUpdate,
  canRemoveChecklistItem,
} from "@/lib/hms/checklist/execution";
import { ensureChecklistForNewWorkOrderTx } from "@/lib/hms/checklist/engine";

function eq(actual: unknown, expected: unknown, msg: string) {
  assert.deepStrictEqual(actual, expected, msg);
}

const hvac = (over: Partial<ChecklistExecutionItem> = {}): ChecklistExecutionItem => ({
  id: "i1",
  label: "Inspect compressor",
  status: "PENDING",
  statusReason: "",
  done: false,
  required: true,
  responseType: "CHECKBOX",
  response: "",
  notes: "",
  requiresPhoto: false,
  failRequiresFinding: false,
  ...over,
});

console.log("RED — pure checklist rules");
eq(canonicalizeCategory(null), "GENERAL", "null -> GENERAL");
eq(canonicalizeCategory("POWER"), "ELECTRICAL", "POWER -> ELECTRICAL");
eq(canonicalizeCategory("ELEC"), "ELECTRICAL", "ELEC -> ELECTRICAL");
eq(canonicalizeCategory("ELECTRIC"), "ELECTRICAL", "ELECTRIC -> ELECTRICAL");
eq(canonicalizeCategory("FIRE_SAFETY"), "FIRE_PROTECTION", "FIRE_SAFETY -> FIRE_PROTECTION");
eq(canonicalizeCategory("FIRE"), "FIRE_PROTECTION", "FIRE -> FIRE_PROTECTION");
eq(canonicalizeCategory("VERTICAL_TRANSPORT"), "LIFT", "VERTICAL_TRANSPORT -> LIFT");
eq(canonicalizeCategory("ELEVATOR"), "LIFT", "ELEVATOR -> LIFT");
eq(canonicalizeCategory("LIFT_ESCALATOR"), "LIFT", "LIFT_ESCALATOR -> LIFT");
eq(canonicalizeCategory("BUILDING_MAINTENANCE"), "BUILDING", "BUILDING_MAINTENANCE -> BUILDING");
eq(canonicalizeCategory("CIVIL_WORKS"), "CIVIL", "CIVIL_WORKS -> CIVIL");
eq(canonicalizeCategory("PEST"), "PEST_CONTROL", "PEST -> PEST_CONTROL");
eq(canonicalizeCategory("hvac"), "HVAC", "lowercase hvac -> HVAC");
eq(canonicalizeCategory("unknown-thing"), "GENERAL", "unknown -> GENERAL");

eq(inferCategory("air conditioner not cooling", ""), "HVAC", "keywords infer HVAC");
eq(inferCategory("weird glorp", ""), "GENERAL", "unknown -> GENERAL");

eq(inferWorkType("COMPLAINT", "leak", ""), "TROUBLESHOOTING", "complaint -> troubleshooting");
eq(inferWorkType("PM", "service", ""), "PREVENTIVE", "pm -> preventive");
eq(inferWorkType("WORK_ORDER", "install pump", ""), "INSTALLATION", "install -> installation");

eq(validateChecklistForSubmission([hvac()], {}, "SUBMIT").ok, false, "required unanswered blocks submit");
eq(validateChecklistForSubmission([hvac({ status: "NOT_APPLICABLE", statusReason: "Not installed" })], {}, "SUBMIT").ok, true, "N/A with reason satisfies");
eq(validateChecklistForSubmission([hvac({ status: "NOT_APPLICABLE" })], {}, "SUBMIT").ok, false, "N/A without reason blocks");
eq(validateChecklistForSubmission([hvac({ status: "BLOCKED", statusReason: "Awaiting part" })], {}, "SUBMIT").ok, false, "required blocked blocks");
eq(validateChecklistForSubmission([hvac({ status: "BLOCKED", statusReason: "Awaiting part", required: false })], {}, "SUBMIT").ok, true, "optional blocked does not block");
eq(validateChecklistForSubmission([hvac({ requiresPhoto: true, status: "COMPLETED" })], {}, "SUBMIT").ok, false, "photo required blocks");
eq(validateChecklistForSubmission([hvac({ requiresPhoto: true, status: "COMPLETED" })], { i1: 1 }, "SUBMIT").ok, true, "per-item photo satisfies");

const now = new Date();
const baseItem: any = {
  id: "i1", label: "Inspect compressor", status: "PENDING", statusReason: "", done: false,
  required: true, responseType: "CHECKBOX", response: "", notes: "", requiresPhoto: false,
  failRequiresFinding: false, safetyCritical: false,
};
eq(resolveChecklistItemUpdate({ current: { ...baseItem }, patch: { done: true }, actorId: "tech", isSupervisor: false, now }).data.status, "COMPLETED", "done=true -> COMPLETED");
assert.throws(
  () => resolveChecklistItemUpdate({ current: { ...baseItem, status: "COMPLETED" }, patch: { status: "IN_PROGRESS" }, actorId: "tech", isSupervisor: false, now }),
  (err: unknown) => err instanceof Error && (err as { code?: string }).code === "FORBIDDEN",
  "technician cannot reopen completed item"
);
eq(canRemoveChecklistItem({ ...baseItem, status: "COMPLETED" }, false), false, "technician cannot remove completed item");
eq(canRemoveChecklistItem({ ...baseItem, status: "PENDING", required: false, safetyCritical: false }, false), true, "technician can remove optional pending item");

class Rollback extends Error {}

console.log("RED — DB checklist generation");
try {
  await db.$transaction(async (tx) => {
    const stamp = Date.now();
    const customer = await tx.customer.create({
      data: { code: `CUST-CHKL-${stamp}`, contactPerson: "Test Customer", email: `test${stamp}@example.com` },
    });
    const equipment = await tx.equipment.create({
      data: { assetTag: `EQ-CHKL-${stamp}`, name: "AC Unit", category: "HVAC", customerId: customer.id },
    });
    const wo = await tx.workOrder.create({
      data: {
        code: `WO-CHKL-${stamp}`, title: "AC not cooling", description: "", customerId: customer.id,
        equipmentId: equipment.id, status: "PENDING", sourceType: "GENERAL",
        labourTotalCents: 0, materialsTotalCents: 0, totalCents: 0,
      },
    });

    const checklist = await ensureChecklistForNewWorkOrderTx(tx, {
      workOrderId: wo.id, title: wo.title, description: wo.description, sourceType: wo.sourceType,
      equipmentCategory: equipment.category, manualLabels: [], actorId: null,
    });
    eq(checklist.created, true, "first generation creates a checklist");
    eq(checklist.itemCount > 0, true, "checklist has items");
    eq(checklist.origin, "TEMPLATE", "HVAC template used");

    const items = await tx.workOrderChecklistItem.findMany({ where: { workOrderId: wo.id }, orderBy: { sortOrder: "asc" } });
    eq(items.some((it) => it.label.includes("Confirm reported cooling issue")), true, "HVAC template items present");
    eq(items.every((it) => it.status === "PENDING" && !it.removedAt), true, "items start PENDING and not removed");

    const second = await ensureChecklistForNewWorkOrderTx(tx, {
      workOrderId: wo.id, title: wo.title, description: wo.description, sourceType: wo.sourceType,
      equipmentCategory: equipment.category, manualLabels: [], actorId: null,
    });
    eq(second.created, false, "retry is idempotent");
    eq(second.itemCount, items.length, "retry returns same item count");
    const countAfter = await tx.workOrderChecklistItem.count({ where: { workOrderId: wo.id } });
    eq(countAfter, items.length, "no duplicate items on retry");

    const equipmentPower = await tx.equipment.create({
      data: { assetTag: `EQ-POWER-${stamp}`, name: "Panel", category: "POWER", customerId: customer.id },
    });
    const woPower = await tx.workOrder.create({
      data: {
        code: `WO-POWER-${stamp}`, title: "Power fault", description: "", customerId: customer.id,
        equipmentId: equipmentPower.id, status: "PENDING", sourceType: "GENERAL",
        labourTotalCents: 0, materialsTotalCents: 0, totalCents: 0,
      },
    });
    const checklistPower = await ensureChecklistForNewWorkOrderTx(tx, {
      workOrderId: woPower.id, title: "Power fault", description: "", sourceType: "GENERAL",
      equipmentCategory: "POWER", manualLabels: [], actorId: null,
    });
    eq(checklistPower.created, true, "POWER category generates a checklist");
    const powerItems = await tx.workOrderChecklistItem.findMany({ where: { workOrderId: woPower.id } });
    eq(powerItems.some((it) => it.label.includes("Isolate supply")), true, "POWER alias resolves to ELECTRICAL template");

    const toExecutionItem = (it: any): ChecklistExecutionItem => ({
      id: it.id, label: it.label, status: it.status, statusReason: it.statusReason, done: it.done,
      doneAt: it.doneAt ?? null, completedById: it.completedById ?? null,
      required: it.required, responseType: it.responseType, response: it.response, notes: it.notes,
      requiresPhoto: !!it.requiresPhoto, failRequiresFinding: !!it.failRequiresFinding,
      safetyCritical: !!it.safetyCritical, group: it.group, priority: it.priority,
      expectedResult: it.expectedResult, unit: it.unit, removedAt: it.removedAt ?? null,
    });

    const target = items[0];
    const edit = resolveChecklistItemUpdate({ current: toExecutionItem(target), patch: { label: target.label + " (edited)", notes: "rechecked" }, actorId: "tech-1", isSupervisor: false, now: new Date() });
    eq(edit.data.status, "IN_PROGRESS", "response/note edit advances PENDING to IN_PROGRESS");
    await tx.workOrderChecklistItem.update({ where: { id: target.id }, data: edit.data });
    await audit({ actorId: null, actorEmail: "tech-1@example.com", action: "WO_CHECKLIST_EDITED", resourceType: "WORK_ORDER", resourceId: wo.id, metadata: { itemId: target.id, label: target.label } });
    const auditRow = await db.auditLog.findFirst({ where: { action: "WO_CHECKLIST_EDITED", resourceId: wo.id }, orderBy: { createdAt: "desc" } });
    eq(!!auditRow, true, "item edit is audited");

    assert.throws(
      () => resolveChecklistItemUpdate({ current: toExecutionItem(target), patch: { status: "NOT_APPLICABLE" }, actorId: "tech-1", isSupervisor: false, now: new Date() }),
      (err: unknown) => (err as { code?: string }).code === "BAD_REQUEST",
      "NOT_APPLICABLE without reason is rejected"
    );
    const na = resolveChecklistItemUpdate({ current: toExecutionItem(target), patch: { status: "NOT_APPLICABLE", statusReason: "Not applicable" }, actorId: "tech-1", isSupervisor: false, now: new Date() });
    await tx.workOrderChecklistItem.update({ where: { id: target.id }, data: na.data });

    const blocked = resolveChecklistItemUpdate({ current: { ...toExecutionItem(target), status: "NOT_APPLICABLE" }, patch: { status: "BLOCKED", statusReason: "awaiting part" }, actorId: "tech-1", isSupervisor: false, now: new Date() });
    await tx.workOrderChecklistItem.update({ where: { id: target.id }, data: blocked.data });
    await notifyRole("SUPERVISOR", { title: "Checklist item blocked", message: `Item "${target.label}" on work order ${wo.code} is blocked: awaiting part`, type: "WARNING", resourceType: "WORK_ORDER", resourceId: wo.id });
    const notification = await db.notification.findFirst({ where: { title: "Checklist item blocked" } });
    eq(!!notification, true, "supervisor is notified when an item becomes BLOCKED");

    const optional = await tx.workOrderChecklistItem.create({ data: { workOrderId: wo.id, label: "Optional extra", required: false, safetyCritical: false, status: "PENDING", sortOrder: items.length + 1 } });
    await tx.workOrderChecklistItem.update({ where: { id: optional.id }, data: { removedAt: new Date(), removedById: "tech-1", removalReason: "not needed" } });
    const remaining = await tx.workOrderChecklistItem.findFirst({ where: { workOrderId: wo.id, id: optional.id, removedAt: null } });
    eq(remaining, null, "soft-removed item is hidden from execution queries");

    const completedRequired = await tx.workOrderChecklistItem.create({ data: { workOrderId: wo.id, label: "Required completed", required: true, safetyCritical: false, status: "COMPLETED", done: true, doneAt: new Date(), completedById: "tech-1", sortOrder: items.length + 2 } });
    assert.throws(
      () => resolveChecklistItemUpdate({ current: toExecutionItem(completedRequired), patch: { status: "IN_PROGRESS" }, actorId: "tech-1", isSupervisor: false, now: new Date() }),
      (err: unknown) => (err as { code?: string }).code === "FORBIDDEN",
      "technician cannot reopen a completed required item"
    );
    eq(canRemoveChecklistItem(toExecutionItem(completedRequired), false), false, "technician cannot remove a completed required item");

    throw new Rollback();
  });
} catch (err) {
  if (!(err instanceof Rollback)) throw err;
}
console.log("GREEN — DB checklist generation passed");

