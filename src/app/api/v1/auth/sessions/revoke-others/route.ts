// MOHD.HMS ENTERPRISE — Active session management (Profile → Security).
// POST /api/v1/auth/sessions/revoke-others — "Sign Out All Other Sessions".
// Deletes every session of the CURRENT user except the current one. Deleted
// rows include any remember-grants on other devices, so their auto login
// stops working immediately. The current session stays signed in.

import { handler, ok, Errors } from "@/lib/hms/api";
import { SESSION_COOKIE } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit, notify } from "@/lib/hms/services";

export const POST = handler(async ({ req, user }) => {
  const currentToken = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const result = await db.session.deleteMany({
    where: { userId: user.id, token: { not: currentToken } },
  });
  await audit({
    actorId: user.id, actorEmail: user.email,
    action: "SESSIONS_REVOKED_OTHERS", resourceType: "SESSION",
    metadata: { revokedCount: result.count },
  });
  if (result.count > 0) {
    // §security-notifications: in-app notice via the EXISTING NotificationService.
    await notify({
      userId: user.id,
      title: "Sessions signed out",
      message: `${result.count} other session(s) on other devices were signed out and can no longer auto-login.`,
      type: "INFO", resourceType: "SESSION",
    });
  }
  if (!currentToken) throw Errors.unauthorized();
  return ok({ revoked: result.count });
});
