// MOHD.HMS ENTERPRISE — USER-CONTROLLED AUTO LOGIN (§auto-login).
// POST /api/v1/auth/auto-login/disable
//
// Disables the persistent-login grant for the CURRENT device. Per spec the
// CURRENT session is NOT terminated (no unnecessary forced re-login) — only
// future restorations stop: the grant flag is cleared so the next idle expiry
// destroys the session row entirely (historical behavior).

import { handler, ok, Errors } from "@/lib/hms/api";
import { SESSION_COOKIE } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";

export const POST = handler(
  async ({ req, user }) => {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (!token) throw Errors.unauthorized();
    const session = await db.session.findUnique({ where: { token } });
    if (!session || session.userId !== user.id) throw Errors.unauthorized();

    await db.session.update({
      where: { id: session.id },
      data: { remember: false },
    });

    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "AUTO_LOGIN_DISABLED", resourceType: "SESSION", resourceId: session.id,
    });
    return ok({ autoLogin: false, detail: "Auto login disabled for this device." });
  }
);
