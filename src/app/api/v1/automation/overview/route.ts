// MOHD.HMS ENTERPRISE — Automation admin API (§63/§104 AUTOMATION DASHBOARD).
// GET → live engine KPIs from real data: outbox counts, per-workflow run stats,
// failed/dead-lettered jobs, scheduler heartbeat, current automation settings.

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { lastEngineTick, registeredWorkflows } from "@/lib/hms/workflows/engine";
import { getAutomationSettings, AUTOMATION_SETTING_DEFAULTS } from "@/lib/hms/workflows/settings";

export const GET = handler(
  async () => {
    const since24h = new Date(Date.now() - 24 * 3_600_000);

    const [eventCounts, runCounts, failedRuns, deadLetters, pendingCount, settings] = await Promise.all([
      db.domainEvent.groupBy({ by: ["status"], _count: { _all: true } }),
      db.workflowRun.groupBy({ by: ["result"], where: { startedAt: { gte: since24h } }, _count: { _all: true } }),
      db.workflowRun.findMany({
        where: { result: "FAILED", startedAt: { gte: since24h } },
        orderBy: { startedAt: "desc" },
        take: 10,
        include: { event: { select: { type: true, resourceType: true, resourceId: true, status: true } } },
      }),
      db.domainEvent.findMany({
        where: { status: "DEAD" },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
      db.domainEvent.count({ where: { status: "PENDING" } }),
      getAutomationSettings(),
    ]);

    const byStatus = Object.fromEntries(eventCounts.map((r) => [r.status, r._count._all]));
    const runs24h = Object.fromEntries(runCounts.map((r) => [r.result, r._count._all]));

    // Per-automation status rows for the admin panel (§63).
    const lastRuns = await db.workflowRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 400,
      select: { workflow: true, result: true, startedAt: true, detail: true },
    });
    const lastByWorkflow = new Map<string, { result: string; startedAt: string; detail: string }>();
    const successByWorkflow = new Map<string, number>();
    const failedByWorkflow = new Map<string, number>();
    for (const run of lastRuns) {
      if (!lastByWorkflow.has(run.workflow)) lastByWorkflow.set(run.workflow, { result: run.result, startedAt: run.startedAt.toISOString(), detail: run.detail });
      if (run.result === "SUCCESS") successByWorkflow.set(run.workflow, (successByWorkflow.get(run.workflow) ?? 0) + 1);
      if (run.result === "FAILED") failedByWorkflow.set(run.workflow, (failedByWorkflow.get(run.workflow) ?? 0) + 1);
    }
    const get = (w: string) => lastByWorkflow.get(w) ?? null;
    const ok24 = (w: string) => successByWorkflow.get(w) ?? 0;
    const fail24 = (w: string) => failedByWorkflow.get(w) ?? 0;

    const automations = [
      { key: "outbox_worker", label: "Outbox Worker", enabled: true, heartbeatAt: lastEngineTick() ? new Date(lastEngineTick()).toISOString() : null, lastRun: null, success: 0, failed: 0 },
      { key: "auto_invoice", label: "Auto Draft Invoice", enabled: settings.auto_invoice_on_confirm === "on", lastRun: get("AUTO_CREATE_DRAFT_INVOICE"), success: ok24("AUTO_CREATE_DRAFT_INVOICE"), failed: fail24("AUTO_CREATE_DRAFT_INVOICE") },
      { key: "auto_work_order", label: "Auto Work Order", enabled: settings.auto_work_order_on_accept === "on", lastRun: get("AUTO_CREATE_WORK_ORDER"), success: ok24("AUTO_CREATE_WORK_ORDER"), failed: fail24("AUTO_CREATE_WORK_ORDER") },
      { key: "pm_scheduler", label: "PM Scheduler", enabled: settings.auto_pm_task_generation === "on", lastRun: get("PM_AUTO_GENERATE_TASK"), success: ok24("PM_AUTO_GENERATE_TASK"), failed: fail24("PM_AUTO_GENERATE_TASK") },
      { key: "pm_reminders", label: "PM Reminders", enabled: settings.auto_pm_task_generation === "on", lastRun: get("PM_REMIND"), success: ok24("PM_REMIND"), failed: fail24("PM_REMIND") },
      { key: "low_stock_monitor", label: "Low Stock Monitor", enabled: settings.low_stock_alerts === "on", lastRun: get("LOW_STOCK_ALERT"), success: ok24("LOW_STOCK_ALERT"), failed: fail24("LOW_STOCK_ALERT") },
      { key: "escalation_engine", label: "Escalation Engine", enabled: settings.escalation_engine === "on", lastRun: get("ESCALATE_COMPLAINT"), success: ok24("ESCALATE_COMPLAINT"), failed: fail24("ESCALATE_COMPLAINT") },
      { key: "sla_engine", label: "SLA Engine", enabled: settings.sla_engine === "on", lastRun: get("SLA_BREACH"), success: ok24("SLA_BREACH"), failed: fail24("SLA_BREACH") },
      { key: "invoice_overdue", label: "Invoice Overdue", enabled: settings.invoice_overdue_automation === "on", lastRun: get("INVOICE_OVERDUE_MARK"), success: ok24("INVOICE_OVERDUE_MARK"), failed: fail24("INVOICE_OVERDUE_MARK") },
      { key: "email_queue", label: "Email Queue", enabled: settings.email_notifications === "on", lastRun: get("EMAIL_DELIVER"), success: ok24("EMAIL_DELIVER"), failed: fail24("EMAIL_DELIVER") },
      { key: "payment_receipt", label: "Payment Receipts", enabled: true, lastRun: get("CUSTOMER_PAYMENT_RECEIPT"), success: ok24("CUSTOMER_PAYMENT_RECEIPT"), failed: fail24("CUSTOMER_PAYMENT_RECEIPT") },
    ];

    return ok({
      events: {
        pending: pendingCount,
        done: byStatus["DONE"] ?? 0,
        processing: byStatus["PROCESSING"] ?? 0,
        dead: byStatus["DEAD"] ?? 0,
      },
      runs24h,
      automations,
      failedRuns: failedRuns.map((r) => ({
        id: r.id, eventId: r.eventId, workflow: r.workflow, detail: r.detail, startedAt: r.startedAt.toISOString(),
        eventType: r.event.type, resourceType: r.event.resourceType, resourceId: r.event.resourceId, eventStatus: r.event.status,
      })),
      deadLetters: deadLetters.map((e) => ({
        id: e.id, type: e.type, resourceType: e.resourceType, resourceId: e.resourceId,
        attempts: e.attempts, maxAttempts: e.maxAttempts, lastError: e.lastError, createdAt: e.createdAt.toISOString(),
      })),
      settings,
      defaults: AUTOMATION_SETTING_DEFAULTS,
      registry: registeredWorkflows(),
    });
  },
  { permission: PERMISSIONS.settings_read }
);
