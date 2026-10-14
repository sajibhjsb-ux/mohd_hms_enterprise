// MOHD.HMS ENTERPRISE — Realtime presence API (STEP 18).
// Returns the live presence snapshot maintained by the realtime service
// (live sockets, NOT "record exists"), FILTERED to the viewer's role BEFORE it
// leaves the server (shared policy: src/lib/hms/realtime/presence.ts).
//
//   SUPER_ADMIN | ADMIN → all online users + total unique-user count
//   SUPERVISOR          → online TECHNICIAN users only + technician count
//   TECHNICIAN | CUSTOMER | FINANCE | HR → own presence only, no global count
//
// The role comes from the verified session, so request parameters/body can
// never widen visibility. This mirrors the socket.io path exactly (one policy).

import { handler, ok } from "@/lib/hms/api";
import { presenceVisibility, scopePresence, type PresenceEntry } from "@/lib/hms/realtime/presence";

const SERVICE_URL = process.env.REALTIME_INTERNAL_URL ?? "http://127.0.0.1:3004";
const SECRET = process.env.REALTIME_INTERNAL_SECRET ?? "hms-realtime-internal-secret-v1";

export const GET = handler(async ({ user }) => {
  const empty = {
    serviceOnline: false,
    scope: presenceVisibility(user.role),
    count: null as number | null,
    connectedClients: null as number | null,
    online: [] as { userId: string; name: string; role: string; since: string }[],
  };
  const res = await fetch(`${SERVICE_URL}/internal/health`, {
    headers: { "x-realtime-secret": SECRET },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return ok(empty);
  const json = (await res.json()) as {
    ok: boolean;
    data?: { connectedClients: number; presence: PresenceEntry[] };
  };
  if (!json.ok || !json.data) return ok(empty);

  const scope = scopePresence(user.role, user.id, json.data.presence);
  return ok({
    serviceOnline: true,
    scope: scope.visibility,
    count: scope.count,
    // Raw socket count is a system-level metric — only ever exposed to the
    // full-visibility roles; everyone else gets null (never a global number).
    connectedClients: scope.visibility === "all" ? json.data.connectedClients : null,
    online: scope.presence.map((p) => ({
      userId: p.userId,
      name: p.name,
      role: p.role,
      since: new Date(p.since).toISOString(),
    })),
  });
});
