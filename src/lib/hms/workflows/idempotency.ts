// MOHD.HMS ENTERPRISE — Submission idempotency (§6/§91 double-click test).
// An in-memory, short-TTL guard keyed by user + route + payload hash. A rapid
// duplicate submission (double click, flaky retry) gets a 409 instead of a second
// business record. Cache/ephemeral layer only — the authoritative uniqueness still
// lives in database constraints (unique codes, one-invoice-per-complaint checks).

import "server-only";
import { createHash } from "crypto";
import { Errors } from "@/lib/hms/api";

type Entry = { at: number };
const seen = new Map<string, Entry>();
const TTL_MS = 5_000;

function prune(now: number): void {
  if (seen.size < 1_000) return;
  for (const [k, v] of seen) if (now - v.at > TTL_MS) seen.delete(k);
}

/**
 * Throw 409 CONFLICT when the same user submits the same payload to the same
 * route twice within the TTL window. Call right after parseBody() in create routes.
 */
export function dedupeSubmission(ctx: { userId?: string; route: string; body: unknown }): void {
  const now = Date.now();
  prune(now);
  const hash = createHash("sha1").update(JSON.stringify(ctx.body ?? null)).digest("hex").slice(0, 24);
  const key = `${ctx.userId ?? "anon"}|${ctx.route}|${hash}`;
  const prior = seen.get(key);
  if (prior && now - prior.at < TTL_MS) {
    throw Errors.conflict("Duplicate submission detected. The first request is still being processed — please do not double-click.");
  }
  seen.set(key, { at: now });
}
