// MOHD.HMS ENTERPRISE — Workflow definitions & actions (§2/§10–§31/§59/§62/§67/§68).
// Every automatic business action lives here, registered against its explicit
// trigger event (§102 NO HIDDEN AUTOMATION — each handler documents its rule).
// All handlers are idempotent: engine-level (SUCCESS run per event, §6) plus a
// business-state re-check inside each handler.

import "server-only";
import { db } from "@/lib/db";
import { audit, nextNumber, notify, notifyRole } from "@/lib/hms/services";
import { formatCurrency } from "@/lib/hms/format";
import { isAutomationEnabled, automationNumber } from "./settings";
import { emit } from "./bus";
import { EVENT_TYPES, type EventType } from "./types";
import { registerWorkflow, type WorkflowResult } from "./engine";

/** §17/§22 — dedupe window: no repeated alerts for the same unresolved condition. */
async function hasRecentRun(workflow: string, resourceId: string, hours: number): Promise<boolean> {
  const since = new Date(Date.now() - hours * 3_600_000);
  const row = await db.workflowRun.findFirst({
    where: { workflow, resourceId, result: { in: ["SUCCESS", "SKIPPED"] }, startedAt: { gte: since } },
    select: { id: true },
  });
  return !!row;
}

// ─── §68: Complaint confirmed → ONE draft invoice for finance review ───
registerWorkflow(EVENT_TYPES.COMPLAINT_CONFIRMED, "AUTO_CREATE_DRAFT_INVOICE", async (ctx) => {
  if (!(await isAutomationEnabled("auto_invoice_on_confirm"))) {
    return { result: "SKIPPED", detail: "auto_invoice_on_confirm disabled" };
  }
  const complaint = await db.complaint.findUnique({
    where: { id: ctx.resourceId },
    include: {
      workOrders: { include: { materials: true } },
      customer: { select: { id: true, companyName: true } },
    },
  });
  if (!complaint) return { result: "SKIPPED", detail: "complaint missing" };
  if (await db.invoice.findFirst({ where: { complaintId: complaint.id }, select: { id: true } })) {
    return { result: "SKIPPED", detail: "invoice already exists for complaint" };
  }
  if (complaint.workOrders.some((w) => w.invoiceId)) {
    return { result: "SKIPPED", detail: "linked work order already invoiced" };
  }
  // Build billable lines from work orders (labour + inventoried/recorded materials).
  type Line = { kind: string; itemId?: string | null; description: string; quantity: number; unit: string; unitPriceCents: number; totalCents: number };
  const lines: Line[] = [];
  for (const wo of complaint.workOrders) {
    const labour = Math.round(wo.labourHours * wo.labourRateCents);
    if (labour > 0) {
      lines.push({ kind: "LABOUR", description: `Labour — ${wo.title} (${wo.code})`, quantity: wo.labourHours, unit: "hr", unitPriceCents: wo.labourRateCents, totalCents: labour });
    }
    for (const m of wo.materials) {
      if (m.totalCents > 0) {
        // Inventory spec §53 — carry the canonical item link onto invoice lines.
        lines.push({ kind: "MATERIAL", itemId: m.inventoryItemId, description: `${m.name} (${wo.code})`, quantity: m.quantity, unit: m.unit, unitPriceCents: m.unitCostCents, totalCents: m.totalCents });
      }
    }
  }
  if (lines.length === 0) return { result: "SKIPPED", detail: "no billable items on linked work orders" };

  // §25/§55 backend-authoritative totals.
  const subtotalCents = lines.reduce((s, l) => s + l.totalCents, 0);
  const code = await nextNumber("INV");
  const invoice = await db.invoice.create({
    data: {
      code,
      customerId: complaint.customerId,
      complaintId: complaint.id,
      status: "DRAFT",
      subtotalCents,
      totalCents: subtotalCents,
      balanceCents: subtotalCents,
      dueDate: new Date(Date.now() + 30 * 86400000),
      notes: `Auto-generated draft from complaint ${complaint.code} (customer confirmed).`,
      items: { create: lines.map((l) => ({ kind: l.kind, itemId: l.itemId ?? null, description: l.description, quantity: l.quantity, unit: l.unit, unitPriceCents: l.unitPriceCents, totalCents: l.totalCents })) },
    },
    select: { id: true, code: true },
  });
  await audit({
    actorEmail: "SYSTEM", action: "AUTO_CREATE_DRAFT_INVOICE",
    resourceType: "INVOICE", resourceId: invoice.id,
    metadata: { invoiceCode: invoice.code, complaintCode: complaint.code, subtotalCents, lines: lines.length },
  });
  // §40 — the complaint's workflow timeline must show the automation step too.
  await audit({
    actorEmail: "SYSTEM", action: "INVOICE_CREATED_AUTOMATICALLY",
    resourceType: "COMPLAINT", resourceId: complaint.id,
    metadata: { invoiceCode: invoice.code, subtotalCents },
  });
  await Promise.all([
    notifyRole("FINANCE", { title: "Draft invoice ready for review", message: `Draft invoice ${invoice.code} was generated automatically from confirmed complaint ${complaint.code} (${formatCurrency(subtotalCents / 100)}).`, type: "INFO", resourceType: "INVOICE", resourceId: invoice.id }),
    notifyRole("ADMIN", { title: "Draft invoice generated", message: `Complaint ${complaint.code} confirmed → draft invoice ${invoice.code} created automatically.`, type: "INFO", resourceType: "INVOICE", resourceId: invoice.id }),
  ]);
  // Realtime (STEP 14): finance sees the automation-generated invoice live.
  await emit({ type: EVENT_TYPES.INVOICE_CREATED, resourceType: "INVOICE", resourceId: invoice.id, payload: { code: invoice.code, totalCents: subtotalCents, customerId: complaint.customerId }, actorType: "SYSTEM" });
  return { result: "SUCCESS", detail: `created draft invoice ${invoice.code}` };
});

// ─── §68: Standalone billable work order completed → draft invoice ───
registerWorkflow(EVENT_TYPES.WORK_ORDER_COMPLETED, "AUTO_CREATE_DRAFT_INVOICE_WO", async (ctx) => {
  if (!(await isAutomationEnabled("auto_invoice_on_wo_complete"))) {
    return { result: "SKIPPED", detail: "auto_invoice_on_wo_complete disabled" };
  }
  const wo = await db.workOrder.findUnique({ where: { id: ctx.resourceId }, include: { materials: true } });
  if (!wo) return { result: "SKIPPED", detail: "work order missing" };
  if (wo.invoiceId || (await db.invoice.findFirst({ where: { workOrderId: wo.id }, select: { id: true } }))) {
    return { result: "SKIPPED", detail: "work order already invoiced" };
  }
  if (wo.complaintId) {
    // Complaint-linked work order: the confirmation flow invoices it. But if the
    // customer ALREADY confirmed (late-completing work order), invoice it here —
    // one complaint still gets at most ONE auto-generated draft invoice (§68).
    const complaint = await db.complaint.findUnique({ where: { id: wo.complaintId }, select: { status: true } });
    if (!complaint) return { result: "SKIPPED", detail: "complaint missing" };
    if (!["CONFIRMED", "CLOSED"].includes(complaint.status)) {
      return { result: "SKIPPED", detail: "complaint not yet confirmed — invoicing follows complaint confirmation" };
    }
    if (await db.invoice.findFirst({ where: { complaintId: wo.complaintId }, select: { id: true } })) {
      return { result: "SKIPPED", detail: "complaint already invoiced" };
    }
  }
  if (wo.totalCents <= 0) return { result: "SKIPPED", detail: "not billable (total 0)" };

  const code = await nextNumber("INV");
  const invoice = await db.invoice.create({
    data: {
      code,
      customerId: wo.customerId,
      workOrderId: wo.id,
      ...(wo.complaintId ? { complaintId: wo.complaintId } : {}),
      status: "DRAFT",
      subtotalCents: wo.totalCents,
      totalCents: wo.totalCents,
      balanceCents: wo.totalCents,
      dueDate: new Date(Date.now() + 30 * 86400000),
      notes: `Auto-generated draft from work order ${wo.code}.`,
      items: { create: [
        ...(wo.labourTotalCents > 0 ? [{ kind: "LABOUR", description: `Labour — ${wo.title}`, quantity: wo.labourHours, unit: "hr", unitPriceCents: wo.labourRateCents, totalCents: wo.labourTotalCents }] : []),
        // Inventory spec §53 — keep the canonical item link on auto-invoiced material lines.
        ...wo.materials.filter((m) => m.totalCents > 0).map((m) => ({ kind: "MATERIAL", itemId: m.inventoryItemId, description: m.name, quantity: m.quantity, unit: m.unit, unitPriceCents: m.unitCostCents, totalCents: m.totalCents })),
      ] },
    },
    select: { id: true, code: true },
  });
  await db.workOrder.update({ where: { id: wo.id }, data: { invoiceId: invoice.id } });
  await audit({
    actorEmail: "SYSTEM", action: "AUTO_CREATE_DRAFT_INVOICE",
    resourceType: "INVOICE", resourceId: invoice.id,
    metadata: { invoiceCode: invoice.code, workOrderCode: wo.code, totalCents: wo.totalCents },
  });
  if (wo.complaintId) {
    // §40 — visible on the complaint's workflow timeline.
    await audit({
      actorEmail: "SYSTEM", action: "INVOICE_CREATED_AUTOMATICALLY",
      resourceType: "COMPLAINT", resourceId: wo.complaintId,
      metadata: { invoiceCode: invoice.code, totalCents: wo.totalCents },
    });
  }
  await notifyRole("FINANCE", { title: "Draft invoice ready for review", message: `Draft invoice ${invoice.code} was generated automatically from completed work order ${wo.code}.`, type: "INFO", resourceType: "INVOICE", resourceId: invoice.id });
  // Realtime (STEP 14): finance sees the automation-generated invoice live.
  await emit({ type: EVENT_TYPES.INVOICE_CREATED, resourceType: "INVOICE", resourceId: invoice.id, payload: { code: invoice.code, totalCents: wo.totalCents, customerId: wo.customerId }, actorType: "SYSTEM" });
  return { result: "SUCCESS", detail: `created draft invoice ${invoice.code}` };
});

// ─── §13: Complaint accepted without a work order → automatic work order ───
async function autoCreateWorkOrder(ctx: { resourceId: string; eventType: string }): Promise<WorkflowResult> {
  if (!(await isAutomationEnabled("auto_work_order_on_accept"))) {
    return { result: "SKIPPED", detail: "auto_work_order_on_accept disabled" };
  }
  const complaint = await db.complaint.findUnique({
    where: { id: ctx.resourceId },
    include: { assignedTechnician: { select: { id: true, userId: true } } },
  });
  if (!complaint) return { result: "SKIPPED", detail: "complaint missing" };
  if (await db.workOrder.findFirst({ where: { complaintId: complaint.id }, select: { id: true } })) {
    return { result: "SKIPPED", detail: "work order already exists for complaint" };
  }
  const code = await nextNumber("WO");
  const wo = await db.workOrder.create({
    data: {
      code,
      complaintId: complaint.id,
      customerId: complaint.customerId,
      equipmentId: complaint.equipmentId,
      technicianId: complaint.assignedTechnicianId,
      title: complaint.title,
      description: complaint.description,
      priority: complaint.priority,
      status: "PENDING",
      // §9 — explicit source so the source=COMPLAINT filter works.
      sourceType: "COMPLAINT",
    },
    select: { id: true, code: true },
  });
  await audit({
    actorEmail: "SYSTEM", action: "AUTO_CREATE_WORK_ORDER",
    resourceType: "WORK_ORDER", resourceId: wo.id,
    metadata: { workOrderCode: wo.code, complaintCode: complaint.code, trigger: ctx.eventType },
  });
  // §40 — visible on the complaint's workflow timeline.
  await audit({
    actorEmail: "SYSTEM", action: "WORK_ORDER_CREATED_AUTOMATICALLY",
    resourceType: "COMPLAINT", resourceId: complaint.id,
    metadata: { workOrderCode: wo.code },
  });
  await notifyRole("SUPERVISOR", { title: "Work order created automatically", message: `Work order ${wo.code} was generated from complaint ${complaint.code}.`, type: "INFO", resourceType: "WORK_ORDER", resourceId: wo.id });
  if (complaint.assignedTechnician?.userId) {
    await notify({ userId: complaint.assignedTechnician.userId, title: "Work order created", message: `Work order ${wo.code} for complaint ${complaint.code} is pending your acceptance.`, type: "INFO", resourceType: "WORK_ORDER", resourceId: wo.id });
  }
  // Realtime (STEP 13/40): the auto-created work order reaches technician + staff + customer live.
  await emit({ type: EVENT_TYPES.WORK_ORDER_CREATED, resourceType: "WORK_ORDER", resourceId: wo.id, payload: { code: wo.code, workOrderId: wo.id, customerId: complaint.customerId }, actorType: "SYSTEM" });
  return { result: "SUCCESS", detail: `created work order ${wo.code}` };
}
registerWorkflow(EVENT_TYPES.COMPLAINT_ACCEPTED, "AUTO_CREATE_WORK_ORDER", (ctx) => autoCreateWorkOrder(ctx));
registerWorkflow(EVENT_TYPES.COMPLAINT_STARTED, "AUTO_CREATE_WORK_ORDER", (ctx) => autoCreateWorkOrder(ctx));

// ─── §17: Low stock alert (deduplicated per item per 24h) ───
registerWorkflow(EVENT_TYPES.LOW_STOCK, "LOW_STOCK_ALERT", async (ctx) => {
  if (!(await isAutomationEnabled("low_stock_alerts"))) {
    return { result: "SKIPPED", detail: "low_stock_alerts disabled" };
  }
  if (await hasRecentRun("LOW_STOCK_ALERT", ctx.resourceId, 24)) {
    return { result: "SKIPPED", detail: "alert already raised within 24h" };
  }
  const item = await db.inventoryItem.findUnique({ where: { id: ctx.resourceId }, select: { id: true, sku: true, name: true, stockQty: true, minStockQty: true } });
  if (!item) return { result: "SKIPPED", detail: "item missing" };
  if (item.stockQty > item.minStockQty) return { result: "SKIPPED", detail: "stock recovered above minimum" };
  await Promise.all([
    notifyRole("ADMIN", { title: "Low stock alert", message: `Low stock: ${item.sku} ${item.name} at ${item.stockQty} (minimum ${item.minStockQty}).`, type: "WARNING", resourceType: "INVENTORY_ITEM", resourceId: item.id }),
    notifyRole("SUPERVISOR", { title: "Low stock alert", message: `Low stock: ${item.sku} ${item.name} at ${item.stockQty} (minimum ${item.minStockQty}). Consider raising a purchase request.`, type: "WARNING", resourceType: "INVENTORY_ITEM", resourceId: item.id }),
  ]);
  await audit({ actorEmail: "SYSTEM", action: "LOW_STOCK_ALERT", resourceType: "INVENTORY_ITEM", resourceId: item.id, metadata: { sku: item.sku, stockQty: item.stockQty, minStockQty: item.minStockQty } });
  return { result: "SUCCESS", detail: `alerted admin+supervisor for ${item.sku}` };
});

// ─── §19: Purchase received → procurement notification ───
registerWorkflow(EVENT_TYPES.PURCHASE_RECEIVED, "PURCHASE_RECEIPT_NOTIFY", async (ctx) => {
  const po = await db.purchaseOrder.findUnique({ where: { id: ctx.resourceId }, select: { id: true, code: true, status: true } });
  if (!po) return { result: "SKIPPED", detail: "purchase order missing" };
  if (await hasRecentRun("PURCHASE_RECEIPT_NOTIFY", po.id, 12)) {
    return { result: "SKIPPED", detail: "receipt notification already sent within 12h" };
  }
  await notifyRole("ADMIN", { title: "Purchase order received", message: `Purchase order ${po.code} is now ${po.status}. Inventory and stock movements were updated automatically.`, type: "SUCCESS", resourceType: "PURCHASE_ORDER", resourceId: po.id });
  return { result: "SUCCESS", detail: `notified admin for ${po.code}` };
});

// ─── §20: PM due → automatic occurrence generation (PmTask + PM work order) ───
registerWorkflow(EVENT_TYPES.PM_DUE, "PM_AUTO_GENERATE_TASK", async (ctx) => {
  if (!(await isAutomationEnabled("auto_pm_task_generation"))) {
    return { result: "SKIPPED", detail: "auto_pm_task_generation disabled" };
  }
  const planId = String(ctx.payload.planId ?? ctx.resourceId);
  const { generatePmOccurrence, PmGenerateError } = await import("@/lib/hms/pm/generate");
  try {
    const result = await generatePmOccurrence({ planId, source: "AUTO" });
    if (!result.created) return { result: "SKIPPED", detail: result.reason };
    return { result: "SUCCESS", detail: `generated task ${result.taskCode} + work order ${result.workOrderCode}` };
  } catch (err) {
    if (err instanceof PmGenerateError) return { result: "FAILED", detail: `${err.code}: ${err.message}` };
    throw err;
  }
});

// ─── §21: configurable PM reminders (N days before due, per settings) ───
registerWorkflow(EVENT_TYPES.PM_REMINDER, "PM_REMIND", async (ctx) => {
  const taskId = String(ctx.payload.taskId ?? ctx.resourceId);
  const days = Number(ctx.payload.days ?? 0);
  const task = await db.pmTask.findUnique({
    where: { id: taskId },
    include: { technician: { select: { userId: true } }, plan: { select: { code: true, name: true } } },
  });
  if (!task) return { result: "SKIPPED", detail: "task missing" };
  if (!["SCHEDULED", "OVERDUE"].includes(task.status)) return { result: "SKIPPED", detail: `status ${task.status}` };
  if (await hasRecentRun("PM_REMIND", task.id, 20)) return { result: "SKIPPED", detail: "reminded within 20h" };
  if (task.technician?.userId) {
    await notify({
      userId: task.technician.userId, title: "PM reminder",
      message: `PM task ${task.code} (${task.plan?.name ?? "plan"}) is due in ${days} day(s).`,
      type: "INFO", resourceType: "PM_TASK", resourceId: task.id,
    });
  }
  await audit({ actorEmail: "SYSTEM", action: "PM_REMINDER_SENT", resourceType: "PM_TASK", resourceId: task.id, metadata: { taskCode: task.code, daysBefore: days } });
  return { result: "SUCCESS", detail: `reminded technician for ${task.code} (${days}d)` };
});

// ─── §22: PM overdue marking + notifications (deduped per task) ───
registerWorkflow(EVENT_TYPES.PM_OVERDUE, "PM_OVERDUE_MARK", async (ctx) => {
  const taskId = String(ctx.payload.taskId ?? ctx.resourceId);
  const task = await db.pmTask.findUnique({
    where: { id: taskId },
    include: { technician: { select: { userId: true } }, plan: { select: { code: true, name: true } } },
  });
  if (!task) return { result: "SKIPPED", detail: "task missing" };
  const flipped = await db.pmTask.updateMany({
    where: { id: task.id, status: "SCHEDULED" },
    data: { status: "OVERDUE" },
  });
  if (flipped.count === 0) return { result: "SKIPPED", detail: `status ${task.status} — not flipped` };
  if (task.technician?.userId) {
    await notify({ userId: task.technician.userId, title: "PM task overdue", message: `PM task ${task.code} (${task.plan?.name ?? task.plan?.code ?? "plan"}) is overdue. Please complete it as soon as possible.`, type: "WARNING", resourceType: "PM_TASK", resourceId: task.id });
  }
  await notifyRole("SUPERVISOR", { title: "PM task overdue", message: `PM task ${task.code} is overdue.`, type: "WARNING", resourceType: "PM_TASK", resourceId: task.id });
  await audit({ actorEmail: "SYSTEM", action: "PM_OVERDUE_MARKED", resourceType: "PM_TASK", resourceId: task.id, metadata: { taskCode: task.code } });
  return { result: "SUCCESS", detail: `marked ${task.code} OVERDUE` };
});

// ─── §34: complaint not accepted within configured hours → escalate to supervisor ───
registerWorkflow(EVENT_TYPES.ESCALATE_COMPLAINT_NOT_ACCEPTED, "ESCALATE_COMPLAINT", async (ctx) => {
  if (!(await isAutomationEnabled("escalation_engine"))) {
    return { result: "SKIPPED", detail: "escalation_engine disabled" };
  }
  const complaint = await db.complaint.findUnique({ where: { id: ctx.resourceId }, select: { id: true, code: true, status: true, assignedAt: true } });
  if (!complaint || complaint.status !== "ASSIGNED") return { result: "SKIPPED", detail: `status ${complaint?.status ?? "missing"}` };
  if (await hasRecentRun("ESCALATE_COMPLAINT", complaint.id, 24)) {
    return { result: "SKIPPED", detail: "escalated within 24h already" };
  }
  const hours = await automationNumber("complaint_accept_escalation_hours", 4);
  const assignedAt = complaint.assignedAt?.getTime() ?? 0;
  if (!assignedAt || Date.now() - assignedAt < hours * 3_600_000) {
    return { result: "SKIPPED", detail: "within escalation window" };
  }
  await notifyRole("SUPERVISOR", { title: "Complaint not accepted", message: `Complaint ${complaint.code} has been assigned for over ${hours}h without technician acceptance.`, type: "WARNING", resourceType: "COMPLAINT", resourceId: complaint.id });
  await audit({ actorEmail: "SYSTEM", action: "ESCALATION_SENT", resourceType: "COMPLAINT", resourceId: complaint.id, metadata: { reason: "NOT_ACCEPTED", hours } });
  return { result: "SUCCESS", detail: `escalated ${complaint.code} to supervisor` };
});

// ─── §59: SLA response breach (priority-based targets) ───
registerWorkflow(EVENT_TYPES.SLA_BREACH_COMPLAINT, "SLA_BREACH", async (ctx) => {
  if (!(await isAutomationEnabled("sla_engine"))) return { result: "SKIPPED", detail: "sla_engine disabled" };
  const complaint = await db.complaint.findUnique({ where: { id: ctx.resourceId }, select: { id: true, code: true, status: true, priority: true, createdAt: true } });
  if (!complaint) return { result: "SKIPPED", detail: "complaint missing" };
  if (!["NEW", "ASSIGNED"].includes(complaint.status)) return { result: "SKIPPED", detail: `responded (status ${complaint.status})` };
  if (await hasRecentRun("SLA_BREACH", complaint.id, 24)) return { result: "SKIPPED", detail: "breach already reported within 24h" };
  const targets = JSON.parse(ctx.payload.targetsSnapshot ? String(ctx.payload.targetsSnapshot) : "{}") as Record<string, number>;
  const target = targets[complaint.priority] ?? 24;
  if (Date.now() - complaint.createdAt.getTime() < target * 3_600_000) {
    return { result: "SKIPPED", detail: "within SLA target" };
  }
  await notifyRole("SUPERVISOR", { title: "SLA breach", message: `Complaint ${complaint.code} (${complaint.priority}) exceeded its ${target}h response target.`, type: "ERROR", resourceType: "COMPLAINT", resourceId: complaint.id });
  await audit({ actorEmail: "SYSTEM", action: "SLA_BREACH_RECORDED", resourceType: "COMPLAINT", resourceId: complaint.id, metadata: { priority: complaint.priority, targetHours: target } });
  return { result: "SUCCESS", detail: `SLA breach recorded for ${complaint.code}` };
});

// ─── §62: work order stuck IN_PROGRESS beyond configured days → escalate ───
registerWorkflow(EVENT_TYPES.WO_OVERDUE, "WO_OVERDUE_ESCALATE", async (ctx) => {
  if (!(await isAutomationEnabled("escalation_engine"))) return { result: "SKIPPED", detail: "escalation_engine disabled" };
  const wo = await db.workOrder.findUnique({ where: { id: ctx.resourceId }, select: { id: true, code: true, status: true, startedAt: true } });
  if (!wo || wo.status !== "IN_PROGRESS") return { result: "SKIPPED", detail: `status ${wo?.status ?? "missing"}` };
  if (await hasRecentRun("WO_OVERDUE_ESCALATE", wo.id, 24)) return { result: "SKIPPED", detail: "escalated within 24h already" };
  const days = await automationNumber("wo_overdue_escalation_days", 2);
  const startedAt = wo.startedAt?.getTime() ?? 0;
  if (!startedAt || Date.now() - startedAt < days * 86400000) return { result: "SKIPPED", detail: "within window" };
  await notifyRole("SUPERVISOR", { title: "Work order running long", message: `Work order ${wo.code} has been in progress for more than ${days} day(s).`, type: "WARNING", resourceType: "WORK_ORDER", resourceId: wo.id });
  await audit({ actorEmail: "SYSTEM", action: "ESCALATION_SENT", resourceType: "WORK_ORDER", resourceId: wo.id, metadata: { reason: "WO_OVERDUE", days } });
  return { result: "SUCCESS", detail: `escalated ${wo.code}` };
});

// ─── §22/§27: invoice past due → mark OVERDUE + notify finance (deduped per invoice) ───
registerWorkflow(EVENT_TYPES.INVOICE_OVERDUE, "INVOICE_OVERDUE_MARK", async (ctx) => {
  if (!(await isAutomationEnabled("invoice_overdue_automation"))) {
    return { result: "SKIPPED", detail: "invoice_overdue_automation disabled" };
  }
  const invoice = await db.invoice.findUnique({ where: { id: ctx.resourceId }, select: { id: true, code: true, status: true, dueDate: true, balanceCents: true } });
  if (!invoice) return { result: "SKIPPED", detail: "invoice missing" };
  if (!["SENT", "PARTIALLY_PAID"].includes(invoice.status)) return { result: "SKIPPED", detail: `status ${invoice.status}` };
  if (!invoice.dueDate || invoice.dueDate.getTime() >= Date.now()) return { result: "SKIPPED", detail: "not yet due" };
  if (invoice.balanceCents <= 0) return { result: "SKIPPED", detail: "no balance" };
  const flipped = await db.invoice.updateMany({ where: { id: invoice.id, status: { in: ["SENT", "PARTIALLY_PAID"] } }, data: { status: "OVERDUE" } });
  if (flipped.count === 0) return { result: "SKIPPED", detail: "concurrent status change" };
  await notifyRole("FINANCE", { title: "Invoice overdue", message: `Invoice ${invoice.code} is past its due date with an outstanding balance of ${formatCurrency(invoice.balanceCents / 100)}.`, type: "WARNING", resourceType: "INVOICE", resourceId: invoice.id });
  await audit({ actorEmail: "SYSTEM", action: "INVOICE_MARKED_OVERDUE", resourceType: "INVOICE", resourceId: invoice.id, metadata: { invoiceCode: invoice.code, balanceCents: invoice.balanceCents } });
  return { result: "SUCCESS", detail: `marked ${invoice.code} OVERDUE` };
});

// ─── §29: payment receipt → customer notification ───
registerWorkflow(EVENT_TYPES.PAYMENT_RECEIVED, "CUSTOMER_PAYMENT_RECEIPT", async (ctx) => {
  const invoice = await db.invoice.findUnique({
    where: { id: ctx.resourceId },
    include: { customer: { select: { portalUser: { select: { id: true } } } } },
  });
  if (!invoice) return { result: "SKIPPED", detail: "invoice missing" };
  const portalUserId = invoice.customer.portalUser?.id;
  if (!portalUserId) return { result: "SKIPPED", detail: "no portal user" };
  const amount = Number(ctx.payload.amountCents ?? 0) / 100;
  await notify({
    userId: portalUserId, title: "Payment received",
    message: `Payment of ${formatCurrency(amount)} received for invoice ${invoice.code}. Thank you.`,
    type: "SUCCESS", resourceType: "INVOICE", resourceId: invoice.id,
  });
  return { result: "SUCCESS", detail: "customer receipt notification created" };
});

// ─── §30: centralized email queue — EVENT → EMAIL_SEND → EmailService ───
// The EMAIL_SEND event is the generic email channel: the recipient receives the
// SAME message in-app (Notification row) and by email (GENERAL_NOTIFICATION
// template) — separate delivery channels over the same domain event (§51).
registerWorkflow(EVENT_TYPES.EMAIL_SEND, "EMAIL_DELIVER", async (ctx) => {
  const toUserId = String(ctx.payload.userId ?? "");
  const title = String(ctx.payload.title ?? "Notification");
  const message = String(ctx.payload.message ?? "");
  if (!toUserId) return { result: "SKIPPED", detail: "no recipient" };
  if (!(await isAutomationEnabled("email_notifications"))) {
    return { result: "SKIPPED", detail: "email channel disabled (settings)" };
  }
  // In-app visible record (existing behavior, keeps every notification surface working).
  await db.notification.create({
    data: { userId: toUserId, channel: "EMAIL", type: "INFO", title, message, resourceType: ctx.resourceType, resourceId: ctx.resourceId },
  });
  // REAL delivery through the ONE centralized EmailService (queued → worker → SMTP).
  const { queueDirect } = await import("@/lib/hms/email/service");
  const user = await db.user.findUnique({ where: { id: toUserId }, select: { email: true, name: true } });
  if (!user) return { result: "SKIPPED", detail: "recipient user missing" };
  const queued = await queueDirect({
    templateKey: "GENERAL_NOTIFICATION",
    to: user.email,
    toUserId,
    category: "SYSTEM",
    relatedType: ctx.resourceType,
    relatedId: ctx.resourceId,
    data: { NOTIFICATION_TITLE: title, NOTIFICATION_MESSAGE: message, USER_NAME: user.name },
  });
  if (!queued.ok) return { result: "SKIPPED", detail: `email not queued: ${queued.reason}` };
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", channel: "EMAIL", to: user.email, title, queued: true }));
  return { result: "SUCCESS", detail: "email queued via EmailService" };
});

// ─── Checklist engine (AI checklist spec §23/§36/§69): complaint created →
//     optional AUTO draft checklist (template-first, AI only when enabled).
//     Configuration-gated (auto_checklist_for_complaints, default OFF) so no AI
//     content is generated for every record unless an administrator enables it.
registerWorkflow(EVENT_TYPES.COMPLAINT_CREATED, "AUTO_CHECKLIST_COMPLAINT", async (ctx) => {
  if (!(await isAutomationEnabled("auto_checklist_for_complaints"))) {
    return { result: "SKIPPED", detail: "auto_checklist_for_complaints disabled" };
  }
  const complaint = await db.complaint.findUnique({ where: { id: ctx.resourceId }, select: { id: true, status: true, code: true } });
  if (!complaint) return { result: "SKIPPED", detail: "complaint missing" };
  if (["CANCELLED", "CLOSED"].includes(complaint.status)) return { result: "SKIPPED", detail: "complaint closed" };
  const { autoGenerateForSource } = await import("@/lib/hms/checklist/engine");
  const detail = await autoGenerateForSource("COMPLAINT", complaint.id);
  if (detail.startsWith("generated")) {
    await audit({
      actorEmail: "SYSTEM", action: "CHECKLIST_GENERATED_AUTOMATICALLY",
      resourceType: "COMPLAINT", resourceId: complaint.id, metadata: { complaintCode: complaint.code, detail },
    });
    return { result: "SUCCESS", detail };
  }
  return { result: "SKIPPED", detail };
});

// ─── Checklist engine: work order created → attach the complaint's APPROVED
//     checklist snapshot (§28) and optionally template-generate for plain WOs.
//     Fires for BOTH manual creation and the auto-created complaint WO, because
//     both paths emit WORK_ORDER_CREATED. AI is never auto-run here — §23.
registerWorkflow(EVENT_TYPES.WORK_ORDER_CREATED, "AUTO_CHECKLIST_WORK_ORDER", async (ctx) => {
  const workOrderId = String(ctx.payload.workOrderId ?? ctx.resourceId);
  const wo = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, complaintId: true, code: true } });
  if (!wo) return { result: "SKIPPED", detail: "work order missing" };
  const { autoAttachForComplaint, autoGenerateForWorkOrder } = await import("@/lib/hms/checklist/engine");
  if (wo.complaintId) {
    const detail = await autoAttachForComplaint(wo.complaintId);
    if (detail.startsWith("attached")) return { result: "SUCCESS", detail: `${detail} (${wo.code})` };
  }
  if (!(await isAutomationEnabled("auto_checklist_for_work_orders"))) {
    return { result: "SKIPPED", detail: "auto_checklist_for_work_orders disabled" };
  }
  const detail = await autoGenerateForWorkOrder(wo.id);
  if (detail.startsWith("generated")) return { result: "SUCCESS", detail: `${detail} (${wo.code})` };
  return { result: "SKIPPED", detail };
});

/** Event types that have at least one registered workflow (observability). */
export function registeredEventTypes(): EventType[] {
  return Object.keys(EVENT_TYPES) as EventType[];
}
