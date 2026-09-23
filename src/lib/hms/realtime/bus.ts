"use client";

// MOHD.HMS ENTERPRISE — Realtime event bus (client).
// Tiny pub/sub decoupling the socket connection from UI subscribers.
// Events delivered here originate ONLY from the server's verified session
// socket — the frontend never emits business events (realtime spec STEP 52).

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

type Handler = (payload: unknown) => void;

const g = globalThis as unknown as {
  __hmsRealtimeBus?: {
    typed: Map<string, Set<Handler>>;
    wildcard: Set<Handler>;
    stateHandlers: Set<(s: RealtimeState) => void>;
    resyncHandlers: Set<() => void>;
    presenceHandlers: Set<(count: number | null) => void>;
    /** Last count pushed by the server while the socket was live. A
     *  late-subscribing header (e.g. after the mobile-search toggle remounts
     *  it) re-reads this instead of flashing a loading state. Freshness is
     *  decided by the CONNECTION state, never by this cached value. */
    presenceCount: number | null;
  };
};

const bus = (g.__hmsRealtimeBus ??= {
  typed: new Map<string, Set<Handler>>(),
  wildcard: new Set<Handler>(),
  stateHandlers: new Set<(s: RealtimeState) => void>(),
  resyncHandlers: new Set<() => void>(),
  presenceHandlers: new Set<(count: number | null) => void>(),
  presenceCount: null,
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
 * Subscribe to the backend-authoritative ONLINE USER COUNT (unique users,
 * deduplicated by the server's presence manager — never raw sockets).
 * Transport-level channel (like connection state), NOT a business event:
 * it arrives regardless of the active view and is never suppressed by the
 * dirty-form guard. Re-emits the last known count to new subscribers.
 */
export function onRealtimePresenceCount(handler: (count: number | null) => void): () => void {
  bus.presenceHandlers.add(handler);
  if (bus.presenceCount !== null) handler(bus.presenceCount);
  return () => bus.presenceHandlers.delete(handler);
}

/** @internal — socket layer publishes the server's presence count. */
export function publishPresenceCount(count: number | null): void {
  bus.presenceCount = count;
  for (const h of [...bus.presenceHandlers]) h(count);
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
