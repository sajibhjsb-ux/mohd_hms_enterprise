// MOHD.HMS ENTERPRISE — User-activity report (idle-session keepalive).
//
// POST /api/v1/auth/activity  (auth)
//
// Advances THIS session's lastActivityAt — the ONLY thing in the system that
// can. The client calls this from REAL user-event listeners (pointer, keys,
// touch, scroll, navigation), throttled to a low frequency; background
// traffic (API polling, the /auth/session heartbeat, WebSocket heartbeats,
// token refresh) NEVER calls it, so it cannot keep an idle session alive.
//
// Scoped to the exact session token from the request cookie — activity in one
// browser/device never extends a different device's idle session.
//
// Auth flows through the standard handler → getSessionUser(): if the session
// already crossed the idle threshold, this request is rejected with
// 401 SESSION_EXPIRED like any other (the server stays authoritative).

import { handler, ok, Errors } from "@/lib/hms/api";
import { SESSION_COOKIE } from "@/lib/hms/auth";
import { db } from "@/lib/db";

export const POST = handler(async ({ req, user }) => {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) throw Errors.unauthorized();
  const result = await db.session.updateMany({
    where: { token, userId: user.id }, // token + owner — no IDOR surface
    data: { lastActivityAt: new Date() },
  });
  if (result.count === 0) throw Errors.unauthorized();
  return ok({ activityRecorded: true });
});
