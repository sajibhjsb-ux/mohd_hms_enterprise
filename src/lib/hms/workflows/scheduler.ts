// MOHD.HMS ENTERPRISE — Backend scheduler / worker (§35).
// Runs inside the Next.js server process, started from src/instrumentation.ts at
// boot. It never depends on a browser tab being open:
//   • every 10s — outbox worker tick (process due DomainEvents)
//   • every 60s — business scans that raise events: PM due/reminders/overdue,
//     complaint acceptance escalation, SLA breach, WO running-long, invoice overdue
// Every scan is deduplicated (no repeated event spam, §22/§108) and runs in
// try/catch so one failing scan never starves the others.

import "server-only";
import "./handlers"; // side-effect: registers all workflows into the engine
import { db } from "@/lib/db";
import { emit } from "./bus";
import { tickWorkflowEngine } from "./engine";
import { EVENT_TYPES } from "./types";
import { pmReminderDays, slaTargetsHours, automationNumber, isAutomationEnabled } from "./settings";

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
  // b) SCHEDULED tasks whose due date passed → PM_OVERDUE (handler flips status once).
  const overdueTasks = await db.pmTask.findMany({
    where: { status: "SCHEDULED", dueDate: { lt: now } },
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

async function runScans(): Promise<void> {
  if (g.__hmsSchedulerScanRunning) return;
  g.__hmsSchedulerScanRunning = true;
  try {
    await scanPm();
    await scanEscalations();
    await scanSla();
    await scanInvoiceOverdue();
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
  setTimeout(() => { void tickWorkflowEngine(); }, 2_000);
  setInterval(() => { void tickWorkflowEngine(); }, 10_000);
  setTimeout(() => { void runScans(); }, 5_000);
  setInterval(() => { void runScans(); }, 60_000);
}
