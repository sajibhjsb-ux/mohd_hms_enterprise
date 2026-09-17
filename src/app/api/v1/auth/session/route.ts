import { handler, ok } from "@/lib/hms/api";
import { getSessionUser } from "@/lib/hms/auth";

/** Session heartbeat. Sliding renewal happens server-side, silently — no reloads. */
export const GET = handler(
  async ({ user }) => {
    if (!user) return ok({ authenticated: false });
    return ok({
      authenticated: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, customerId: user.customerId, permissions: user.permissions },
      sessionExpiresAt: user.sessionExpiresAt,
    });
  },
  { auth: false }
);
