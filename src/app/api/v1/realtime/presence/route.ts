// MOHD.HMS ENTERPRISE — Realtime presence API (STEP 18).
// Staff roles only. Returns the live presence snapshot maintained by the
// realtime service (live sockets, NOT "record exists").

import { Errors, handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

const SERVICE_URL = process.env.REALTIME_INTERNAL_URL ?? "http://127.0.0.1:3004";
const SECRET = process.env.REALTIME_INTERNAL_SECRET ?? "hms-realtime-internal-secret-v1";

export const GET = handler(
  async ({ user }) => {
    if (user.role === "CUSTOMER" || user.role === "TECHNICIAN") {
      throw Errors.forbidden("Presence is visible to management roles only.");
    }
    const res = await fetch(`${SERVICE_URL}/internal/health`, {
      headers: { "x-realtime-secret": SECRET },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return ok({ online: [], connectedClients: 0, serviceOnline: false });
    const json = (await res.json()) as {
      ok: boolean;
      data?: { connectedClients: number; presence: { userId: string; name: string; role: string; sockets: number; since: number }[] };
    };
    if (!json.ok || !json.data) return ok({ online: [], connectedClients: 0, serviceOnline: false });
    return ok({
      serviceOnline: true,
      connectedClients: json.data.connectedClients,
      online: json.data.presence.map((p) => ({
        userId: p.userId,
        name: p.name,
        role: p.role,
        since: new Date(p.since).toISOString(),
      })),
    });
  },
  { permission: PERMISSIONS.settings_read }
);
