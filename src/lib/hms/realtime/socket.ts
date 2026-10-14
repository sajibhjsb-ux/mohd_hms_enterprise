"use client";

// MOHD.HMS ENTERPRISE — Realtime socket connection (client singleton).
// socket.io transport rides the app's own single production origin: the
// browser connects to the same origin's `/socket.io` endpointhol, and Next's
// rewrite (`/socket.io/:path* -> http://127.0.0.1:3003/:path*`) proxies BOTH
// the engine.io HTTP polling handshake and the WebSocket upgrade to the
// realtime service (verified in the standalone: rewrite destinations with a
// protocol go through upgradeHandler -> proxyRequest -> HttpProxy({ws:true})
// -> proxy.ws, so 1006-on-upgrade is resolved at the proxy, not the client).
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
  publishPresenceFeed,
  type RealtimeEvent, type RealtimeState, type PresenceFeed,
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
  // Same-origin: the Next rewrite (`/socket.io/:path* -> http://127.0.0.1:3003/socket.io/:path*`)
  // carries BOTH engine.io HTTP polling and the WebSocket upgrade (verified in the
  // standalone — rewrite destinations with a protocol go through upgradeHandler →
  // proxyRequest → HttpProxy({ws:true}) → proxy.ws). Dropped the Caddy-only
  // `/?XTransformPort=3003` query transform: production's TCP router never applied it.
  const socket = io("/", {
    path: "/socket.io",
    // engine.io appends a trailing slash by default (`/socket.io/`). Next's
    // default `trailingSlash: false` then 308-redirects that to `/socket.io`,
    // and a 3xx is NOT followed for the WebSocket upgrade — so the handshake
    // never completes through the single-origin rewrite. Request the exact
    // path the rewrite matches (`/socket.io?EIO=…`) and the upgrade succeeds.
    addTrailingSlash: false,
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

  // Backend-authoritative, role-SCOPED presence feed. The server pushes a
  // count whose scope matches THIS socket's role (all users for admin /
  // super-admin, technicians only for a supervisor); self-only roles receive
  // no count at all. The client only accepts a feed whose scope it can render.
  socket.on("presence:count", (p: { scope?: string; count?: number }) => {
    const scope =
      p?.scope === "all" ? "all" :
      p?.scope === "technicians" ? "technicians" :
      p?.scope === "self" ? "self" : null;
    if (!scope) { publishPresenceFeed(null); return; }
    publishPresenceFeed({ scope, count: typeof p.count === "number" && Number.isFinite(p.count) ? p.count : null });
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
  // The feed belongs to a live socket — without one it is no longer current
  // (§13: never present a stale count as fresh). Consumers decide how to
  // render the null ("status unavailable"), never a fabricated 0.
  publishPresenceFeed(null);
  publishRealtimeState("DISCONNECTED");
}
