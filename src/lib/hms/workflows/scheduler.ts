// MOHD.HMS ENTERPRISE — Backend scheduler / worker (§35).
// Runs inside the Next.js server process, started from src/instrumentation.ts at
// boot. It never depends on a browser tab being open:
//   • every 10s — outbox worker tick (process due DomainEvents) + email worker
//     tick (deliver due queued emails — the ONE email delivery loop)
//   • every 60s — business scans that raise events: PM due/reminders/overdue,
//     complaint acceptance escalation, SLA breach, WO running-long, invoice
//     overdue, invoice due-soon, quotation expiring
// Every scan is deduplicated (no repeated event spam, §22/§108) and runs in
// try/catch so one failing scan never starves the others.

import "server-only";
import "./handlers"; // side-effect: registers all workflows into the engine
import { db } from "@/lib/db";
import { emit } from "./bus";
import { tickWorkflowEngine } from "./engine";
import { dispatchPendingEvents } from "@/lib/hms/realtime/dispatcher";
import { EVENT_TYPES } from "./types";
import { pmReminderDays, slaTargetsHours, automationNumber, isAutomationEnabled } from "./settings";
import { bootstrapEmailSystem } from "@/lib/hms/email/bootstrap";
import { tickEmailWorker } from "@/lib/hms/email/service";
import { bootstrapWhatsAppSystem } from "@/lib/hms/whatsapp/bootstrap";
import { tickWhatsAppWorker } from "@/lib/hms/whatsapp/service";
import { tickPushWorker } from "@/lib/hms/push/worker";

const g = globalThis as unknown as { __hmsSchedulerBooted?: boolean; __hmsSchedulerScanRunning?: boolean };

/** True when an event of this type for this resource was already raised recently. */
async function recentEvent(type: string, resourceId: string, hours: number): Promise<boolean> {
  const since = new Date(Date.now() - hours * 3_600_000);
  const row = await db.domainEvent.findFirst({
    where: { type, resourceId, createdAt: { gte: since } },
    select: { id: true },
  });
  return !!row;
}

// ─── Scans ───────────────────────────────────────────────────────────────────

async function scanPm(): Promise<void> {
  if (!(await isAutomationEnabled("auto_pm_task_generation"))) return;
  const now = new Date();
  // a) Plans due within 1 day (or already due) without an open task → PM_DUE.
  const plans = await db.pmPlan.findMany({
    where: { active: true, nextDueDate: { lte: new Date(now.getTime() + 86400000) } },
    select: { id: true, code: true, nextDueDate: true },
    take: 100,
  });
  for (const plan of plans) {
    const open = await db.pmTask.findFirst({
      where: { planId: plan.id, status: { in: ["SCHEDULED", "OVERDUE", "IN_PROGRESS"] } },
      select: { id: true },
    });
    if (open) continue;
    if (await recentEvent(EVENT_TYPES.PM_DUE, plan.id, 12)) continue;
    await emit({ type: EVENT_TYPES.PM_DUE, resourceType: "PM_PLAN", resourceId: plan.id, payload: { planId: plan.id }, actorType: "SYSTEM" });
  }
  // a2) §9/§10 — meter-based plans: the meter crossed its service threshold
  // without an open task → PM_DUE (same occurrence generator, meter occurrence key).
  const meterPlans = await db.pmPlan.findMany({
    where: { active: true, planType: { in: ["METER", "USAGE", "RUNTIME"] }, meterId: { not: null }, meterInterval: { gt: 0 } },
    select: { id: true, code: true, nextDueMeter: true, meter: { select: { currentReading: true } } },
    take: 100,
  });
  for (const plan of meterPlans) {
    const threshold = plan.nextDueMeter ?? plan.meterInterval;
    if (!threshold || !plan.meter || plan.meter.currentReading < threshold) continue;
    const open = await db.pmTask.findFirst({
      where: { planId: plan.id, status: { in: ["SCHEDULED", "OVERDUE", "IN_PROGRESS"] } },
      select: { id: true },
    });
    if (open) continue;
    if (await recentEvent(EVENT_TYPES.PM_DUE, plan.id, 12)) continue;
    await emit({ type: EVENT_TYPES.PM_DUE, resourceType: "PM_PLAN", resourceId: plan.id, payload: { planId: plan.id }, actorType: "SYSTEM" });
  }
  // b) SCHEDULED tasks due before today → PM_OVERDUE (handler flips status once).
  const overdueTasks = await db.pmTask.findMany({
    where: { status: "SCHEDULED", dueDate: { lt: new Date(new Date(now).setHours(0, 0, 0, 0)) } },
    select: { id: true, code: true },
    take: 100,
  });
  for (const task of overdueTasks) {
    if (await recentEvent(EVENT_TYPES.PM_OVERDUE, task.id, 20)) continue;
    await emit({ type: EVENT_TYPES.PM_OVERDUE, resourceType: "PM_TASK", resourceId: task.id, payload: { taskId: task.id }, actorType: "SYSTEM" });
  }
  // c) Configurable reminders N days before due (§21) — PM_REMINDER per matching day.
  const reminderDays = await pmReminderDays();
  if (reminderDays.length) {
    const upcoming = await db.pmTask.findMany({
      where: { status: "SCHEDULED", dueDate: { gte: now, lte: new Date(now.getTime() + Math.max(...reminderDays) * 86400000) } },
      select: { id: true, code: true, dueDate: true },
      take: 200,
    });
    for (const task of upcoming) {
      const days = Math.ceil((task.dueDate.getTime() - now.getTime()) / 86400000);
      if (!reminderDays.includes(days)) continue;
      if (await recentEvent(EVENT_TYPES.PM_REMINDER, task.id, 20)) continue;
      await emit({ type: EVENT_TYPES.PM_REMINDER, resourceType: "PM_TASK", resourceId: task.id, payload: { taskId: task.id, days }, actorType: "SYSTEM" });
    }
  }
}

/**
 * Manual / on-demand scheduler pass (PM §86 — manual safe run): one synchronous
 * scanPm() followed by a realtime dispatch pass so any raised PM events reach
 * connected clients immediately. Fully idempotent — running it twice in a row
 * never creates duplicate work (occurrence keys + dedupe guards apply).
 */
export async function runPmSchedulerOnce(opts?: { kickRealtime?: boolean }): Promise<void> {
  await scanPm();
  if (opts?.kickRealtime !== false) await dispatchPendingEvents();
}

async function scanEscalations(): Promise<void> {
  if (!(await isAutomationEnabled("escalation_engine"))) return;
  const hours = await automationNumber("complaint_accept_escalation_hours", 4);
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const complaints = await db.complaint.findMany({
    where: { status: "ASSIGNED", assignedAt: { lt: cutoff } },
    select: { id: true, code: true },
    take: 100,
  });
  for (const c of complaints) {
    if (await recentEvent(EVENT_TYPES.ESCALATE_COMPLAINT_NOT_ACCEPTED, c.id, 20)) continue;
    await emit({ type: EVENT_TYPES.ESCALATE_COMPLAINT_NOT_ACCEPTED, resourceType: "COMPLAINT", resourceId: c.id, payload: { complaintId: c.id }, actorType: "SYSTEM" });
  }

  const days = await automationNumber("wo_overdue_escalation_days", 2);
  const woCutoff = new Date(Date.now() - days * 86400000);
  const wos = await db.workOrder.findMany({
    where: { status: "IN_PROGRESS", startedAt: { lt: woCutoff } },
    select: { id: true },
    take: 100,
  });
  for (const wo of wos) {
    if (await recentEvent(EVENT_TYPES.WO_OVERDUE, wo.id, 20)) continue;
    await emit({ type: EVENT_TYPES.WO_OVERDUE, resourceType: "WORK_ORDER", resourceId: wo.id, payload: { workOrderId: wo.id }, actorType: "SYSTEM" });
  }
}

async function scanSla(): Promise<void> {
  if (!(await isAutomationEnabled("sla_engine"))) return;
  const targets = await slaTargetsHours();
  const priorities = Object.entries(targets);
  if (!priorities.length) return;
  for (const [priority, targetHours] of priorities) {
    const cutoff = new Date(Date.now() - targetHours * 3_600_000);
    const complaints = await db.complaint.findMany({
      where: { status: { in: ["NEW", "ASSIGNED"] }, priority, createdAt: { lt: cutoff } },
      select: { id: true },
      take: 100,
    });
    for (const c of complaints) {
      if (await recentEvent(EVENT_TYPES.SLA_BREACH_COMPLAINT, c.id, 20)) continue;
      await emit({
        type: EVENT_TYPES.SLA_BREACH_COMPLAINT, resourceType: "COMPLAINT", resourceId: c.id,
        payload: { complaintId: c.id, targetsSnapshot: JSON.stringify(targets) }, actorType: "SYSTEM",
      });
    }
  }
}

async function scanInvoiceOverdue(): Promise<void> {
  if (!(await isAutomationEnabled("invoice_overdue_automation"))) return;
  const invoices = await db.invoice.findMany({
    where: { status: { in: ["SENT", "PARTIALLY_PAID"] }, dueDate: { lt: new Date() }, balanceCents: { gt: 0 } },
    select: { id: true, code: true },
    take: 100,
  });
  for (const inv of invoices) {
    if (await recentEvent(EVENT_TYPES.INVOICE_OVERDUE, inv.id, 20)) continue;
    await emit({ type: EVENT_TYPES.INVOICE_OVERDUE, resourceType: "INVOICE", resourceId: inv.id, payload: { invoiceId: inv.id }, actorType: "SYSTEM" });
  }
}

// ── Email automation scans (§33 delayed emails — same scheduler, no second one) ──

/** Invoices becoming due within 3 days → INVOICE_DUE_SOON (customer reminder). */
async function scanInvoiceDueSoon(): Promise<void> {
  const soon = new Date(Date.now() + 3 * 86_400_000);
  const invoices = await db.invoice.findMany({
    where: { status: { in: ["SENT", "PARTIALLY_PAID"] }, dueDate: { gte: new Date(), lte: soon }, balanceCents: { gt: 0 } },
    select: { id: true, code: true },
    take: 100,
  });
  for (const inv of invoices) {
    if (await recentEvent(EVENT_TYPES.INVOICE_DUE_SOON, inv.id, 40)) continue;
    await emit({ type: EVENT_TYPES.INVOICE_DUE_SOON, resourceType: "INVOICE", resourceId: inv.id, payload: { invoiceId: inv.id }, actorType: "SYSTEM" });
  }
}

/** Quotations expiring within 7 days → QUOTATION_EXPIRING (sales reminder). */
async function scanQuotationExpiring(): Promise<void> {
  const soon = new Date(Date.now() + 7 * 86_400_000);
  const quotations = await db.quotation.findMany({
    where: { status: "SENT", validUntil: { gte: new Date(), lte: soon } },
    select: { id: true, code: true },
    take: 100,
  });
  for (const q of quotations) {
    if (await recentEvent(EVENT_TYPES.QUOTATION_EXPIRING, q.id, 40)) continue;
    await emit({ type: EVENT_TYPES.QUOTATION_EXPIRING, resourceType: "QUOTATION", resourceId: q.id, payload: { quotationId: q.id }, actorType: "SYSTEM" });
  }
}

async function runScans(): Promise<void> {
  if (g.__hmsSchedulerScanRunning) return;
  g.__hmsSchedulerScanRunning = true;
  try {
    await scanPm();
    await scanEscalations();
    await scanSla();
    await scanInvoiceOverdue();
    await scanInvoiceDueSoon();
    await scanQuotationExpiring();
  } catch (e) {
    console.error("scheduler-scan-failed", e);
  } finally {
    g.__hmsSchedulerScanRunning = false;
  }
}

/** Boot the scheduler exactly once per server process. */
export function startScheduler(): void {
  if (g.__hmsSchedulerBooted) return;
  g.__hmsSchedulerBooted = true;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "workflow-scheduler-started" }));
  // Email system bootstrap (templates + automations + engine handlers) — idempotent.
  void bootstrapEmailSystem();
  // WhatsApp system bootstrap (templates + automations + engine handlers) — idempotent.
  void bootstrapWhatsAppSystem();
  setTimeout(() => { void tickWorkflowEngine(); }, 2_000);
  setInterval(() => { void tickWorkflowEngine(); }, 10_000);
  // Email worker — the ONE delivery loop for queued emails (spec: reuse the
  // existing scheduler; no second scheduler). Same cadence as the engine tick.
  setTimeout(() => { void tickEmailWorker(); }, 8_000);
  setInterval(() => { void tickEmailWorker(); }, 10_000);
  // WhatsApp worker — the ONE delivery loop for queued WhatsApp messages
  // (OpenWA gateway transport). Same scheduler, same cadence.
  setTimeout(() => { void tickWhatsAppWorker(); }, 9_000);
  setInterval(() => { void tickWhatsAppWorker(); }, 10_000);
  // Push worker — the ONE delivery loop for queued push notifications
  // (FCM + legacy VAPID transports). Same scheduler, same cadence.
  setTimeout(() => { void tickPushWorker(); }, 11_000);
  setInterval(() => { void tickPushWorker(); }, 10_000);
  // Realtime dispatch safety net (STEP 7/22): pushes committed outbox events to
  // the realtime service. emit() also kicks this directly for low latency.
  setInterval(() => { void dispatchPendingEvents(); }, 2_000);
  setTimeout(() => { void runScans(); }, 5_000);
  setInterval(() => { void runScans(); }, 60_000);
}
