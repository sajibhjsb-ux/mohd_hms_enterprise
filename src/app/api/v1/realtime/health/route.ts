// MOHD.HMS ENTERPRISE — Realtime health API (STEP 49 MONITORING).
// SUPER_ADMIN only (STEP 24: detailed technical diagnostics are never shown to
// normal users). Every value is derived from REAL backend state:
//   • websocket / clients / broadcast stats — the realtime service's own
//     internal health endpoint (live sockets, not assumptions)
//   • dispatcher — the in-process outbox dispatcher's last tick / last error
//   • outbox — authoritative PostgreSQL(-equivalent) DomainEvent queue depth
// The queue/outbox provider is ALWAYS the relational database (PostgreSQL in
// production) — Redis plays no role in this stack, so "redis" is reported as
// "n/a (postgresql-outbox)" rather than faked.
// Top-level `status`: "healthy" (service reachable) / "degraded" (app is
// serving but the realtime service could not be reached). Never a hardcoded
// "healthy".

import { db } from "@/lib/db";
import { Errors, handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { dispatcherHealth } from "@/lib/hms/realtime/dispatcher";

const SERVICE_URL = process.env.REALTIME_INTERNAL_URL ?? "http://127.0.0.1:3004";
const SECRET = process.env.REALTIME_INTERNAL_SECRET ?? "hms-realtime-internal-secret-v1";

type ServiceHealth = {
  status?: string;
  connectedClients: number;
  byRole: Record<string, number>;
  presence: { userId: string; name: string; role: string; sockets: number; since: number; lastSeenAt?: number }[];
  eventsBroadcast: number;
  lastEventAt: string | null;
  lastEvent: string;
  startedAt: string;
  uptimeS: number;
};

export const GET = handler(
  async ({ user }) => {
    if (user.role !== "SUPER_ADMIN") throw Errors.forbidden("Realtime diagnostics are limited to the Super Admin.");

    const [service, pendingEvents, broadcastPending] = await Promise.all([
      fetch(`${SERVICE_URL}/internal/health`, {
        headers: { "x-realtime-secret": SECRET },
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { ok: boolean; data?: ServiceHealth } | null) => (j?.ok ? j.data : null))
        .catch(() => null),
      db.domainEvent.count({ where: { status: "PENDING" } }),
      db.domainEvent.count({ where: { broadcastAt: null, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } }),
    ]);

    const dispatcher = dispatcherHealth();
    const status = service ? "healthy" : "degraded";

    return ok({
      status,
      websocket: service ? "available" : "unavailable",
      // This stack has no Redis: the authoritative queue is the relational
      // outbox and the realtime service is the distribution layer (spec §15 —
      // PostgreSQL stays authoritative; no business data moves to a cache).
      redis: "n/a (postgresql-outbox)",
      dispatcher: { ...dispatcher, running: !!dispatcher.lastDispatchAt },
      connected_clients: service?.connectedClients ?? 0,
      events_broadcast: service?.eventsBroadcast ?? 0,
      outbox_pending: pendingEvents,
      awaiting_broadcast: broadcastPending,
      last_broadcast_at: service?.lastEventAt ?? null,
      last_dispatch_at: dispatcher.lastDispatchAt ? new Date(dispatcher.lastDispatchAt).toISOString() : null,
      // Backward-compatible nested shape consumed by the dashboard:
      service,
      outbox: { pendingEvents, broadcastPending },
    });
  },
  { permission: PERMISSIONS.settings_read }
);
