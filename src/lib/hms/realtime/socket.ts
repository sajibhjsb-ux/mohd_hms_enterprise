"use client";

// MOHD.HMS ENTERPRISE — Realtime socket connection (client singleton).
// socket.io transport through the gateway (`/?XTransformPort=3003`).
//
// Spec coverage:
//   STEP 8  — authenticated: the HttpOnly session cookie rides along on the
//             handshake; the realtime service verifies it against the app's
//             session store. Unauthenticated sockets are rejected server-side.
//   STEP 21 — automatic reconnect with exponential backoff (socket.io built-in,
//             capped delay), explicit connection state machine, heartbeat via
//             socket.io ping/pong. No uncontrolled infinite loop: delays are
//             capped and the socket idles cleanly while connected.
//   STEP 22 — after every (re)connect the client asks for a resync and the
//             active view refetches; PostgreSQL stays authoritative.
//   STEP 6  — duplicate deliveries are dropped by event id (idempotent UI).
//   STEP 52 — NO polling, NO window.location.reload, NO router.refresh. The
//             socket is the only realtime channel; UI updates via cache/state.

import { io, type Socket } from "socket.io-client";
import {
  publishRealtimeEvent, publishRealtimeState, publishRealtimeResync,
  publishPresenceCount,
  type RealtimeEvent, type RealtimeState,
} from "./bus";

const g = globalThis as unknown as {
  __hmsRealtimeSocket?: Socket;
  __hmsRealtimeSeen?: Set<string>;
};

const seen = (g.__hmsRealtimeSeen ??= new Set());

export function getRealtimeSocket(): Socket | null {
  return g.__hmsRealtimeSocket ?? null;
}

export function connectRealtime(): void {
  if (g.__hmsRealtimeSocket) return; // singleton — HMR/navigations reuse it

  publishRealtimeState("CONNECTING");
  const socket = io("/?XTransformPort=3003", {
    path: "/",
    // WebSocket first, polling fallback (proxy/failure tolerance, STEP 29/30).
    transports: ["websocket", "polling"],
    withCredentials: true, // HttpOnly session cookie → server-side auth
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000, // exponential backoff, capped (STEP 21)
    reconnectionAttempts: Infinity,
    timeout: 15_000,
  });
  g.__hmsRealtimeSocket = socket;

  socket.on("connect", () => {
    publishRealtimeState("CONNECTED");
    // STEP 22: reconcile the active view after every fresh connection.
    socket.emit("realtime:sync");
    publishRealtimeResync("socket-connect");
  });

  socket.on("disconnect", (reason) => {
    publishRealtimeState(reason === "io client disconnect" ? "DISCONNECTED" : "RECONNECTING");
  });

  socket.io.on("reconnect_attempt", () => publishRealtimeState("RECONNECTING"));
  socket.io.on("reconnect_failed", () => publishRealtimeState("FAILED"));
  socket.on("connect_error", (err) => {
    // Auth failures surface as connect_error; keep retrying with backoff —
    // the session may renew (sliding sessions) and the next handshake succeeds.
    console.debug(JSON.stringify({ msg: "realtime-connect-error", err: err.message }));
    publishRealtimeState("RECONNECTING");
  });

  // Server asks us to reconcile (reply to realtime:sync).
  socket.on("realtime:resync", () => publishRealtimeResync("server-resync"));

  // Backend-authoritative ONLINE USER COUNT (unique users, server-deduped —
  // presence manager, never raw sockets). Pushed on every connect/disconnect
  // and after revocations; the connection handler broadcasts it to every
  // freshly connected socket, so the count arrives immediately on (re)connect.
  socket.on("presence:count", (p: { count?: number }) => {
    publishPresenceCount(typeof p?.count === "number" && Number.isFinite(p.count) ? p.count : null);
  });

  // Server-enforced session revocation (logout / idle revoke / admin revoke /
  // single-device policy). The session is gone server-side — reconnecting with
  // the same cookie can only fail, so tear the singleton down cleanly instead
  // of burning an infinite backoff loop. A later login re-runs connectRealtime().
  socket.on("realtime:session-invalid", () => {
    publishRealtimeState("DISCONNECTED");
    disconnectRealtime();
  });

  // The one true event channel — small targeted envelopes only (STEP 48).
  socket.on("realtime:event", (raw: RealtimeEvent) => {
    if (!raw?.event_id || !raw?.event_type) return;
    // Idempotency (STEP 6/46): duplicated deliveries never double-update the UI.
    if (seen.has(raw.event_id)) return;
    seen.add(raw.event_id);
    if (seen.size > 1000) {
      const it = seen.values();
      for (let i = 0; i < 200; i++) {
        const v = it.next().value;
        if (v === undefined) break;
        seen.delete(v);
      }
    }
    publishRealtimeEvent(raw);
  });
}

export function disconnectRealtime(): void {
  const socket = g.__hmsRealtimeSocket;
  if (!socket) return;
  g.__hmsRealtimeSocket = undefined;
  socket.disconnect();
  // The count belongs to a live socket — without one it is no longer current
  // (§13: never present a stale count as fresh). Consumers decide how to
  // render the null ("status unavailable"), never a fabricated 0.
  publishPresenceCount(null);
  publishRealtimeState("DISCONNECTED");
}
