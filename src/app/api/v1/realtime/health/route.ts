// MOHD.HMS ENTERPRISE — Realtime health API (STEP 49 MONITORING).
// SUPER_ADMIN only (STEP 24: detailed technical diagnostics are never shown to
// normal users). Aggregates: realtime service status (clients, presence,
// broadcast stats), dispatcher status, and authoritative outbox queue depth.

import { db } from "@/lib/db";
import { Errors, handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { dispatcherHealth } from "@/lib/hms/realtime/dispatcher";

const SERVICE_URL = process.env.REALTIME_INTERNAL_URL ?? "http://127.0.0.1:3004";
const SECRET = process.env.REALTIME_INTERNAL_SECRET ?? "hms-realtime-internal-secret-v1";

export const GET = handler(
  async ({ user }) => {
    if (user.role !== "SUPER_ADMIN") throw Errors.forbidden("Realtime diagnostics are limited to the Super Admin.");

    const [service, pendingEvents, broadcastPending] = await Promise.all([
      fetch(`${SERVICE_URL}/internal/health`, {
        headers: { "x-realtime-secret": SECRET },
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { ok: boolean; data?: unknown } | null) => (j?.ok ? j.data : null))
        .catch(() => null),
      db.domainEvent.count({ where: { status: "PENDING" } }),
      db.domainEvent.count({ where: { broadcastAt: null, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } }),
    ]);

    return ok({
      service,
      dispatcher: dispatcherHealth(),
      outbox: { pendingEvents, broadcastPending },
    });
  },
  { permission: PERMISSIONS.settings_read }
);
