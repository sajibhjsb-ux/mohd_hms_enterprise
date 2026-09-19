// MOHD.HMS ENTERPRISE — Outbox worker / workflow engine (§2/§5/§6/§7/§8).
// Processes DomainEvent rows exactly once:
//   claim (status guard) → run each registered workflow → record WorkflowRun
//   → mark DONE; on failure retry with exponential backoff (§7) and move to
//   DEAD after max attempts, alerting SUPER_ADMIN (§8).
// Idempotency (§6): a workflow with an existing SUCCESS run for the same event is
// skipped — duplicate event delivery can never duplicate business records.
// Single-flight per process (globalThis flag); claims are additionally guarded by
// the status update so concurrent processes/ticks cannot double-execute.

import "server-only";
import { db } from "@/lib/db";
import { audit, notifyRole } from "@/lib/hms/services";
import { EVENT_TYPES, type TxClient } from "./types";

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;
const BATCH = 25;

export type WorkflowResult = { result: "SUCCESS" | "SKIPPED"; detail?: string };

export type WorkflowHandlerCtx = {
  eventId: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  requestId: string;
  tx?: TxClient; // undefined for worker runs (handlers use the primary client)
};

export type WorkflowHandler = (ctx: WorkflowHandlerCtx) => Promise<WorkflowResult>;

/** Workflow → handler registry (single source — no scattered automation, §2).
 *  Stored on globalThis: instrumentation, route chunks and HMR copies must all
 *  share ONE registry, otherwise a kick from a route chunk would see an empty
 *  registry and silently no-op events. */
const gRegistry = globalThis as unknown as { __hmsWorkflowRegistry?: Record<string, { workflow: string; run: WorkflowHandler }[]> };

function registry(): Record<string, { workflow: string; run: WorkflowHandler }[]> {
  return (gRegistry.__hmsWorkflowRegistry ??= {});
}

export function registerWorkflow(eventType: string, workflow: string, run: WorkflowHandler): void {
  const reg = registry();
  (reg[eventType] ??= []).push({ workflow, run });
}

export function registeredWorkflows(): { eventType: string; workflows: string[] }[] {
  return Object.entries(registry()).map(([eventType, hs]) => ({ eventType, workflows: hs.map((h) => h.workflow) }));
}

const g = globalThis as unknown as { __hmsWorkflowRunning?: boolean; __hmsWorkflowLastTick?: number };

/** Process due outbox events. Safe to call concurrently — single-flight per process. */
export async function tickWorkflowEngine(): Promise<number> {
  if (g.__hmsWorkflowRunning) return 0;
  g.__hmsWorkflowRunning = true;
  g.__hmsWorkflowLastTick = Date.now();
  let processed = 0;
  try {
    for (let i = 0; i < BATCH; i++) {
      // Stop after one idle pass — a due event means there may be more.
      const candidate = await db.domainEvent.findFirst({
        where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!candidate) break;
      const claim = await db.domainEvent.updateMany({
        where: { id: candidate.id, status: "PENDING", nextAttemptAt: { lte: new Date() } },
        data: { status: "PROCESSING", attempts: { increment: 1 } },
      });
      if (claim.count !== 1) continue; // another worker claimed it
      const event = await db.domainEvent.findUnique({ where: { id: candidate.id } });
      if (!event) continue;
      await processEvent(event);
      processed++;
    }
  } catch (e) {
    console.error("workflow-tick-failed", e);
  } finally {
    g.__hmsWorkflowRunning = false;
  }
  return processed;
}

export function lastEngineTick(): number {
  return g.__hmsWorkflowLastTick ?? 0;
}

type EventRow = {
  id: string; type: string; resourceType: string; resourceId: string; payload: string;
  attempts: number; maxAttempts: number; requestId: string; actorType: string; actorId: string | null;
};

async function processEvent(event: EventRow): Promise<void> {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(event.payload || "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const ctx: WorkflowHandlerCtx = {
    eventId: event.id, eventType: event.type, resourceType: event.resourceType,
    resourceId: event.resourceId, payload, requestId: event.requestId,
  };

  const handlers = registry()[event.type] ?? [];
  let anyFailed = false;
  let lastError = "";

  if (handlers.length === 0) {
    // No registered workflow for this event type — mark done so it never retries.
    await db.domainEvent.update({
      where: { id: event.id },
      data: { status: "DONE", processedAt: new Date(), lastError: "" },
    });
    return;
  }

  for (const { workflow, run } of handlers) {
    // §6 idempotency — an already-successful workflow for this event is never re-run.
    const priorSuccess = await db.workflowRun.findFirst({
      where: { eventId: event.id, workflow, result: "SUCCESS" },
      select: { id: true },
    });
    if (priorSuccess) continue;

    const startedAt = new Date();
    try {
      const result = await run(ctx);
      await db.workflowRun.create({
        data: {
          eventId: event.id, workflow,
          resourceType: event.resourceType, resourceId: event.resourceId,
          result: result.result, detail: result.detail ?? "",
          actorType: event.actorType, attempt: event.attempts,
          startedAt, completedAt: new Date(),
        },
      });
    } catch (e) {
      anyFailed = true;
      lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await db.workflowRun.create({
        data: {
          eventId: event.id, workflow,
          resourceType: event.resourceType, resourceId: event.resourceId,
          result: "FAILED", detail: lastError.slice(0, 2000),
          actorType: event.actorType, attempt: event.attempts,
          startedAt, completedAt: new Date(),
        },
      }).catch(() => undefined);
    }
  }

  if (anyFailed) {
    if (event.attempts >= event.maxAttempts) {
      // §8 dead-letter — keep full context for SUPER_ADMIN inspection.
      await db.domainEvent.update({
        where: { id: event.id },
        data: { status: "DEAD", lastError: lastError.slice(0, 2000) },
      });
      await audit({
        actorEmail: "SYSTEM", action: "WORKFLOW_DEAD_LETTER",
        resourceType: event.resourceType, resourceId: event.resourceId,
        metadata: { eventId: event.id, eventType: event.type, attempts: event.attempts, error: lastError },
      }).catch(() => undefined);
      await notifyRole("SUPER_ADMIN", {
        title: "Automation failed permanently",
        message: `Event ${event.type} (${event.resourceType} ${event.resourceId}) failed ${event.attempts} attempts: ${lastError.slice(0, 160)}`,
        type: "ERROR", resourceType: event.resourceType, resourceId: event.resourceId,
      }).catch(() => undefined);
    } else {
      // §7 exponential backoff — 30s, 1m, 2m, 4m … capped at 15m.
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, event.attempts - 1), BACKOFF_CAP_MS);
      await db.domainEvent.update({
        where: { id: event.id },
        data: { status: "PENDING", nextAttemptAt: new Date(Date.now() + backoff), lastError: lastError.slice(0, 2000) },
      });
    }
  } else {
    await db.domainEvent.update({
      where: { id: event.id },
      data: { status: "DONE", processedAt: new Date(), lastError: "" },
    });
  }
}

/** SUPER_ADMIN retry (§64): re-queue a FAILED/DEAD event. Idempotency holds —
 *  workflows with prior SUCCESS runs are skipped on reprocessing. */
export async function requeueEvent(eventId: string): Promise<{ ok: boolean; status?: string }> {
  const event = await db.domainEvent.findUnique({ where: { id: eventId }, select: { id: true, status: true } });
  if (!event) return { ok: false };
  if (!["FAILED", "DEAD", "DONE", "PENDING"].includes(event.status)) return { ok: false };
  const updated = await db.domainEvent.updateMany({
    where: { id: eventId, status: { in: ["FAILED", "DEAD", "DONE", "PENDING"] } },
    data: { status: "PENDING", nextAttemptAt: new Date(), lastError: "" },
  });
  if (updated.count === 1) kickSelf();
  return { ok: updated.count === 1, status: "PENDING" };
}

function kickSelf(): void {
  import("./bus").then((m) => m.kickWorkflowEngine()).catch(() => undefined);
}

export { EVENT_TYPES };
