// MOHD.HMS ENTERPRISE — Realtime Service (FULL REALTIME UPDATE SYSTEM)
// socket.io transport: authenticated, role-scoped event delivery to browsers.
//
// Architecture (spec STEP 3/7/8/9/18/21/24/49):
//   Next.js API (mutation) → DomainEvent outbox (PostgreSQL-equivalent, source
//   of truth) → realtime dispatcher → THIS SERVICE → authorized sockets → UI.
//
// Security (STEP 8/9/33):
//   • Every handshake is authenticated against the main app's session endpoint
//     (the HttpOnly `hms_session` cookie rides along through the gateway).
//     Anonymous sockets are rejected — no business events without a session.
//   • Rooms are joined ONLY from the server-verified session (user id, role,
//     customerId) — never from client-supplied claims.
//   • Publish accepts only allow-listed room shapes and is protected by an
//     internal shared secret.
//
// This service keeps NO business state and never touches the database:
// PostgreSQL(-equivalent) stays the single source of truth; this process is a
// pure distribution layer (the spec's Redis/transport role in this stack).

import { createServer } from "http";
import { Server, type Socket } from "socket.io";

const PORT = 3003; // public WebSocket transport (via gateway ?XTransformPort=3003)
const INTERNAL_PORT = Number(process.env.REALTIME_INTERNAL_PORT ?? 3004); // loopback publish/health API
const APP_URL = process.env.HMS_APP_URL ?? "http://127.0.0.1:3000";
const SECRET = process.env.REALTIME_INTERNAL_SECRET ?? "hms-realtime-internal-secret-v1";
const SESSION_CACHE_TTL_MS = 60_000;

type SessionInfo = {
  id: string;
  name: string;
  role: string;
  customerId: string | null;
};

type CacheEntry = { user: SessionInfo; expires: number };

const g = globalThis as unknown as {
  __hmsSessionCache?: Map<string, CacheEntry>;
  __hmsSeenEvents?: Set<string>;
  __hmsStats?: { broadcast: number; lastEventAt: number; lastEvent: string; startedAt: number };
};
const sessionCache = (g.__hmsSessionCache ??= new Map());
const seenEvents = (g.__hmsSeenEvents ??= new Set());
const stats = (g.__hmsStats ??= { broadcast: 0, lastEventAt: 0, lastEvent: "", startedAt: Date.now() });

// ─── Presence (STEP 18) ──────────────────────────────────────────────────────
// "record exists" is never used as an online signal — presence = live sockets.

type PresenceEntry = { name: string; role: string; sockets: number; since: number };
const presence = new Map<string, PresenceEntry>(); // userId → entry

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: "realtime", msg, ...extra }));
}

// ─── Session verification (single source of truth: the app's session store) ──

/** Minimal cookie parser — avoids a dependency version dance for one header. */
function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

async function verifySession(cookieHeader: string | undefined): Promise<SessionInfo | null> {
  const token = readCookie(cookieHeader, "hms_session");
  if (!token) return null;

  const cached = sessionCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.user;

  try {
    const res = await fetch(`${APP_URL}/api/v1/auth/session`, {
      headers: { cookie: `hms_session=${encodeURIComponent(token)}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; data?: { authenticated: boolean; user?: SessionInfo } };
    if (!json.ok || !json.data?.authenticated || !json.data.user) return null;
    const user: SessionInfo = {
      id: json.data.user.id,
      name: json.data.user.name,
      role: json.data.user.role,
      customerId: json.data.user.customerId ?? null,
    };
    sessionCache.set(token, { user, expires: Date.now() + SESSION_CACHE_TTL_MS });
    if (sessionCache.size > 5000) {
      // bounded cache: drop the oldest entries
      const it = sessionCache.keys();
      for (let i = 0; i < 1000; i++) {
        const k = it.next().value;
        if (k === undefined) break;
        sessionCache.delete(k);
      }
    }
    return user;
  } catch (e) {
    log("warn", "session-verify-failed", { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Room membership derives ONLY from the verified session (STEP 9). */
function roomsFor(user: SessionInfo): string[] {
  const rooms = [`user:${user.id}`, `role:${user.role}`];
  if (user.role !== "CUSTOMER") rooms.push("staff");
  if (user.customerId) rooms.push(`customer:${user.customerId}`);
  return rooms;
}

const ALLOWED_ROOM = /^(user:[A-Za-z0-9_-]+|role:[A-Z_]+|customer:[A-Za-z0-9_-]+|staff|all)$/;

// ─── Server ──────────────────────────────────────────────────────────────────

// ─── Internal HTTP API (loopback only — socket.io owns every request on the
// public port, so publish/health get their own server) ───────────────────────

const internalServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${INTERNAL_PORT}`);
  if (req.method === "POST" && url.pathname === "/internal/publish") {
    if (req.headers["x-realtime-secret"] !== SECRET) {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const ev = JSON.parse(body) as {
          event_id: string; event_type: string; version: number;
          aggregate_type: string; aggregate_id: string; timestamp: string;
          actor: { user_id: string | null; type: string };
          data: Record<string, unknown>; rooms: string[];
        };
        if (!ev?.event_id || !Array.isArray(ev.rooms)) {
          res.writeHead(400).end(JSON.stringify({ ok: false, error: "bad-envelope" }));
          return;
        }
        // Idempotency (STEP 6/46): the same event id is broadcast once.
        if (seenEvents.has(ev.event_id)) {
          res.writeHead(200).end(JSON.stringify({ ok: true, deduped: true }));
          return;
        }
        const rooms = ev.rooms.filter((r) => ALLOWED_ROOM.test(r));
        const envelope = {
          event_id: ev.event_id,
          event_type: ev.event_type,
          version: ev.version ?? 1,
          aggregate_type: ev.aggregate_type,
          aggregate_id: ev.aggregate_id,
          timestamp: ev.timestamp,
          actor: ev.actor ?? { user_id: null, type: "SYSTEM" },
          data: ev.data ?? {},
        };
        for (const room of rooms) io.to(room).emit("realtime:event", envelope);
        seenEvents.add(ev.event_id);
        if (seenEvents.size > 10_000) {
          const it = seenEvents.values();
          for (let i = 0; i < 2000; i++) {
            const v = it.next().value;
            if (v === undefined) break;
            seenEvents.delete(v);
          }
        }
        stats.broadcast++;
        stats.lastEventAt = Date.now();
        stats.lastEvent = ev.event_type;
        if (ev.event_type !== "NOTIFICATION_CREATED") {
          log("info", "event-broadcast", { type: ev.event_type, rooms: rooms.length, id: ev.event_id });
        }
        res.writeHead(200).end(JSON.stringify({ ok: true, rooms: rooms.length }));
      } catch (e) {
        log("error", "publish-parse-failed", { err: e instanceof Error ? e.message : String(e) });
        res.writeHead(400).end(JSON.stringify({ ok: false, error: "bad-json" }));
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/internal/health") {
    if (req.headers["x-realtime-secret"] !== SECRET) {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const byRole: Record<string, number> = {};
    for (const [, p] of presence) byRole[p.role] = (byRole[p.role] ?? 0) + p.sockets;
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ok: true,
        data: {
          connectedClients: io.engine.clientsCount,
          byRole,
          presence: Array.from(presence.entries()).map(([userId, p]) => ({ userId, ...p })),
          eventsBroadcast: stats.broadcast,
          lastEventAt: stats.lastEventAt ? new Date(stats.lastEventAt).toISOString() : null,
          lastEvent: stats.lastEvent,
          startedAt: new Date(stats.startedAt).toISOString(),
          uptimeS: Math.round((Date.now() - stats.startedAt) / 1000),
        },
      }),
    );
    return;
  }

  res.writeHead(404).end(JSON.stringify({ ok: false, error: "not-found" }));
});

internalServer.listen(INTERNAL_PORT, "127.0.0.1", () => {
  log("info", "internal-api-started", { port: INTERNAL_PORT });
});

const httpServer = createServer();

const io = new Server(httpServer, {
  // DO NOT change the path — the gateway routes `/?XTransformPort=3003` here.
  path: "/",
  cors: { origin: true, methods: ["GET", "POST"], credentials: true },
  pingTimeout: 60_000,
  pingInterval: 25_000,
  // Socket.io's own handshake + upgrade handling works through the gateway's
  // reverse proxy (STEP 29/30 equivalent in this stack).
});

// ─── Handshake authentication (STEP 8) ───────────────────────────────────────

io.use(async (socket, next) => {
  try {
    const user = await verifySession(socket.handshake.headers.cookie);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    return next();
  } catch {
    return next(new Error("unauthorized"));
  }
});

io.on("connection", (socket: Socket) => {
  const user = socket.data.user as SessionInfo;
  const rooms = roomsFor(user);
  for (const room of rooms) socket.join(room);

  // Presence (STEP 18): connect → online, disconnect → offline. Broadcast to
  // staff so admins see real presence; never derived from DB records.
  const prev = presence.get(user.id);
  presence.set(user.id, {
    name: user.name,
    role: user.role,
    sockets: (prev?.sockets ?? 0) + 1,
    since: prev?.since ?? Date.now(),
  });
  broadcastPresence();

  log("info", "client-connected", { socketId: socket.id, userId: user.id, role: user.role, rooms: rooms.join(",") });

  // Missed-event recovery hook (STEP 22): the client asks for a resync right
  // after (re)connect — it refetches its active view; PostgreSQL stays
  // authoritative. The outbox dispatcher also replays un-broadcast events.
  socket.on("realtime:sync", () => {
    socket.emit("realtime:resync", { serverTime: new Date().toISOString() });
  });

  // Presence list for admin dashboards (staff only — verified server-side).
  socket.on("presence:list", () => {
    if (user.role === "CUSTOMER") return;
    socket.emit("presence:list", {
      presence: Array.from(presence.entries()).map(([userId, p]) => ({ userId, ...p })),
    });
  });

  socket.on("disconnect", (reason) => {
    const entry = presence.get(user.id);
    if (entry) {
      entry.sockets -= 1;
      if (entry.sockets <= 0) presence.delete(user.id);
    }
    broadcastPresence();
    log("info", "client-disconnected", { socketId: socket.id, userId: user.id, reason });
  });

  socket.on("error", (err) => {
    log("warn", "socket-error", { socketId: socket.id, err: err instanceof Error ? err.message : String(err) });
  });
});

function broadcastPresence() {
  io.to("staff").emit("presence:update", {
    presence: Array.from(presence.entries()).map(([userId, p]) => ({ userId, ...p })),
  });
}

httpServer.listen(PORT, () => {
  log("info", "realtime-service-started", { port: PORT, internalPort: INTERNAL_PORT, appUrl: APP_URL });
});

process.on("SIGTERM", () => {
  log("info", "shutdown-sigterm");
  httpServer.close(() => process.exit(0));
  internalServer.close();
});
process.on("SIGINT", () => {
  log("info", "shutdown-sigint");
  httpServer.close(() => process.exit(0));
  internalServer.close();
});
