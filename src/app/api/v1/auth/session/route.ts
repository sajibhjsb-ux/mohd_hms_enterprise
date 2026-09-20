import { handler, ok } from "@/lib/hms/api";
import { getSessionUser, SESSION_IDLE_TIMEOUT_SECONDS } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { customerProfileState } from "@/lib/hms/customer-profile";
import { termsStatusFor } from "@/lib/hms/legal/legal";

/** Session heartbeat. Sliding renewal happens server-side, silently — no reloads.
 *  The payload carries the derived, backend-authoritative profile completion
 *  state so the shell/dashboard can gate restricted customer actions, and the
 *  Terms & Conditions acceptance state so the consent gate stays accurate even
 *  when a new version is published mid-session. */
export const GET = handler(
  async ({ user }) => {
    if (!user) return ok({ authenticated: false });
    const [profileState, terms, avatar] = await Promise.all([
      customerProfileState(user),
      termsStatusFor(user),
      db.user.findUnique({ where: { id: user.id }, select: { avatarUrl: true } }),
    ]);
    const avatarUrl = avatar?.avatarUrl ?? null;
    return ok({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        customerId: user.customerId,
        permissions: user.permissions,
        profileComplete: profileState.profileComplete,
        missingFields: profileState.missingFields,
        terms,
        avatarUrl: avatarUrl,
      },
      sessionExpiresAt: user.sessionExpiresAt,
      // Centralized idle-timeout configuration (seconds) — the client builds
      // its warning/UX timers from THIS value; 300 in production.
      idleTimeoutSeconds: SESSION_IDLE_TIMEOUT_SECONDS,
    });
  },
  { auth: false }
);
