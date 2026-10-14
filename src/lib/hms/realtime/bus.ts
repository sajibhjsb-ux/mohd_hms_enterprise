"use client";

// MOHD.HMS ENTERPRISE — Realtime event bus (client).
// Tiny pub/sub decoupling the socket connection from UI subscribers.
// Events delivered here originate ONLY from the server's verified session
// socket — the frontend never emits business events (realtime spec STEP 52).

import type { PresenceVisibility } from "./presence";

export type RealtimeEvent = {
  event_id: string;
  event_type: string;
  version: number;
  aggregate_type: string;
  aggregate_id: string;
  timestamp: string;
  actor: { user_id: string | null; type: string };
  data: Record<string, unknown>;
};

export type RealtimeState = "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "RECONNECTING" | "FAILED";

/**
 * Backend-authoritative presence feed for the CURRENT viewer. `scope` is the
 * visibility class the server assigned this socket's role — the client must
 * only render data whose scope matches its own (defense in depth; the server
 * already filtered the payload). `count` is null when no global count is
 * permitted for this role (self-only viewers).
 */
export type PresenceFeed = { scope: PresenceVisibility; count: number | null };

type Handler = (payload: unknown) => void;

const g = globalThis as unknown as {
  __hmsRealtimeBus?: {
    typed: Map<string, Set<Handler>>;
    wildcard: Set<Handler>;
    stateHandlers: Set<(s: RealtimeState) => void>;
    resyncHandlers: Set<() => void>;
    presenceHandlers: Set<(feed: PresenceFeed | null) => void>;
    /** Last feed pushed by the server while the socket was live. A
     *  late-subscribing header (e.g. after the mobile-search toggle remounts
     *  it) re-reads this instead of flashing a loading state. Freshness is
     *  decided by the CONNECTION state, never by this cached value. */
    presenceFeed: PresenceFeed | null;
  };
};

const bus = (g.__hmsRealtimeBus ??= {
  typed: new Map<string, Set<Handler>>(),
  wildcard: new Set<Handler>(),
  stateHandlers: new Set<(s: RealtimeState) => void>(),
  resyncHandlers: new Set<() => void>(),
  presenceHandlers: new Set<(feed: PresenceFeed | null) => void>(),
  presenceFeed: null,
});

/** Subscribe to specific realtime event types ("*" matches everything). */
export function onRealtimeEvents(types: string[], handler: Handler): () => void {
  const all = types.includes("*");
  const set = all ? bus.wildcard : null;
  if (!set) {
    for (const t of types) {
      let s = bus.typed.get(t);
      if (!s) bus.typed.set(t, (s = new Set()));
      s.add(handler);
    }
  } else {
    set.add(handler);
  }
  return () => {
    if (all) {
      bus.wildcard.delete(handler);
    } else {
      for (const t of types) bus.typed.get(t)?.delete(handler);
    }
  };
}

/** Subscribe to connection-state changes (STEP 21/24 indicator). */
export function onRealtimeState(handler: (s: RealtimeState) => void): () => void {
  bus.stateHandlers.add(handler);
  return () => bus.stateHandlers.delete(handler);
}

/**
 * Subscribe to the backend-authoritative PRESENCE FEED for this viewer
 * (scoped unique-user count + the visibility class the server assigned).
 * Transport-level channel (like connection state), NOT a business event: it
 * arrives regardless of the active view and is never suppressed by the
 * dirty-form guard. Re-emits the last known feed to new subscribers.
 */
export function onRealtimePresenceFeed(handler: (feed: PresenceFeed | null) => void): () => void {
  bus.presenceHandlers.add(handler);
  if (bus.presenceFeed !== null) handler(bus.presenceFeed);
  return () => bus.presenceHandlers.delete(handler);
}

/** @internal — socket layer publishes the server's scoped presence feed. */
export function publishPresenceFeed(feed: PresenceFeed | null): void {
  bus.presenceFeed = feed;
  for (const h of [...bus.presenceHandlers]) h(feed);
}

/** Register a callback that refetches the ACTIVE view (STEP 22 reconciliation). */
export function onRealtimeResync(handler: () => void): () => void {
  bus.resyncHandlers.add(handler);
  return () => bus.resyncHandlers.delete(handler);
}

/** @internal — socket layer publishes received server events. */
export function publishRealtimeEvent(ev: RealtimeEvent): void {
  const hs = bus.typed.get(ev.event_type);
  if (hs) for (const h of [...hs]) h(ev);
  for (const h of [...bus.wildcard]) h(ev);
}

/** @internal — socket layer publishes connection state. */
export function publishRealtimeState(state: RealtimeState): void {
  for (const h of [...bus.stateHandlers]) h(state);
}

/** @internal — socket layer triggers view reconciliation after (re)connect. */
export function publishRealtimeResync(reason: string): void {
  for (const h of [...bus.resyncHandlers]) {
    try { h(); } catch { /* a broken subscriber must not starve the others */ }
  }
  console.debug(JSON.stringify({ msg: "realtime-resync", reason }));
}
