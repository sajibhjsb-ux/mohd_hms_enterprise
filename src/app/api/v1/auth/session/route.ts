import { handler, ok } from "@/lib/hms/api";
import { getSessionUser } from "@/lib/hms/auth";
import { customerProfileState } from "@/lib/hms/customer-profile";

/** Session heartbeat. Sliding renewal happens server-side, silently — no reloads.
 *  The payload carries the derived, backend-authoritative profile completion
 *  state so the shell/dashboard can gate restricted customer actions. */
export const GET = handler(
  async ({ user }) => {
    if (!user) return ok({ authenticated: false });
    const profileState = await customerProfileState(user);
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
      },
      sessionExpiresAt: user.sessionExpiresAt,
    });
  },
  { auth: false }
);
