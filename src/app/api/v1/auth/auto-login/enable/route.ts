// MOHD.HMS ENTERPRISE — USER-CONTROLLED AUTO LOGIN (§auto-login).
// POST /api/v1/auth/auto-login/enable
//
// Enables the persistent-login grant ("Keep me signed in on this device") for
// the CURRENT device's session. Server-authoritative: the flag lives on the
// Session row (per device), the grant is capped at SESSION_REMEMBER_TTL_MS
// (30 days), never stores any password/credential beyond the existing
// HttpOnly session cookie, and is fully revocable (disable endpoint, manual
// logout, password change/reset, admin reset/disable all destroy it).

import { handler, ok, Errors } from "@/lib/hms/api";
import {
  SESSION_COOKIE, SESSION_REMEMBER_TTL_MS,
} from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit, notify } from "@/lib/hms/services";

export const POST = handler(
  async ({ req, user }) => {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (!token) throw Errors.unauthorized();
    const session = await db.session.findUnique({ where: { token } });
    if (!session || session.userId !== user.id) throw Errors.unauthorized();

    const expiresAt = new Date(Date.now() + SESSION_REMEMBER_TTL_MS);
    await db.session.update({
      where: { id: session.id },
      data: { remember: true, expiresAt },
    });

    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "AUTO_LOGIN_ENABLED", resourceType: "SESSION", resourceId: session.id,
      metadata: { expiresAt: expiresAt.toISOString() },
    });
    // §security-notifications: in-app notice through the EXISTING
    // NotificationService — no new notification system.
    await notify({
      userId: user.id,
      title: "Auto login enabled",
      message: "Keep-me-signed-in was enabled on this device — the session persists on this device until it expires, you sign out, or another device signs in.",
      type: "INFO", resourceType: "SESSION", resourceId: session.id,
    });
    return ok({ autoLogin: true, sessionExpiresAt: expiresAt.toISOString() });
  }
);
