// MOHD.HMS ENTERPRISE — Event outbox bus (§4/§5).
// emit() appends a DomainEvent row — optionally inside the caller's transaction so
// the business write and the event commit atomically — then kicks the outbox worker.
// The worker also polls every few seconds as a safety net, so a kick that races a
// commit simply results in the event being picked up on the next tick.

import "server-only";
import { db } from "@/lib/db";
import type { EmitInput } from "./types";
import { kickRealtimeDispatch } from "@/lib/hms/realtime/dispatcher";

/** Fire-and-forget worker kick (never blocks or fails the business request — §105). */
export function kickWorkflowEngine(): void {
  if (typeof setImmediate !== "function") return;
  setImmediate(() => {
    import("./engine")
      .then((m) => m.tickWorkflowEngine())
      .catch((e) => console.error("workflow-kick-failed", e));
  });
}

/**
 * Append a domain event to the outbox. When `tx` is provided the row is written
 * through the caller's interactive transaction (committed together with the
 * business data, §4); otherwise it is written immediately on the primary client.
 */
export async function emit(input: EmitInput): Promise<string> {
  const data = {
    type: input.type,
    resourceType: input.resourceType ?? "",
    resourceId: input.resourceId ?? "",
    payload: JSON.stringify(input.payload ?? {}),
    actorType: input.actorType ?? "USER",
    actorId: input.actorId ?? null,
    requestId: input.requestId ?? "",
  };
  try {
    if (input.tx) {
      const row = await input.tx.domainEvent.create({ data });
      // The row commits with the caller's transaction; the kick retries shortly
      // after so the committed row is broadcast once it exists (STEP 3/4).
      kickRealtimeDispatch();
      return row.id;
    }
    const row = await db.domainEvent.create({ data });
    kickWorkflowEngine();
    kickRealtimeDispatch();
    return row.id;
  } catch (e) {
    // Event persistence failure must never break the business response (§105),
    // but it MUST be loudly observable — the daily system check also reports gaps.
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "event-emit-failed", type: input.type, resource: input.resourceType, err: e instanceof Error ? e.message : String(e) }));
    return "";
  }
}

/**
 * Emit several events after the caller's transaction has committed successfully.
 * Use this when the emission site sits outside the interactive transaction but
 * should still only run on success (no false automation on rollback, §4).
 */
export async function emitAll(inputs: EmitInput[]): Promise<void> {
  for (const input of inputs) await emit(input);
}
