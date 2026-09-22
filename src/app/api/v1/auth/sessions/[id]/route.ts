// MOHD.HMS ENTERPRISE — Active session management (Profile → Security).
// DELETE /api/v1/auth/sessions/[id] — sign out ONE of the current user's own
// sessions (per-device [Sign Out]). Ownership is enforced (no IDOR): a
// session id belonging to another user is a 404. Revoking the CURRENT session
// behaves like a logout (its cookie is cleared).

import type { NextRequest, NextResponse } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { clearSessionCookie, SESSION_COOKIE } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";

// House pattern (mirrors users/[id]): pass the dynamic params into handler().
const withId = (
  fn: (ctx: { req: NextRequest; user: { id: string; email: string; name: string; role: string }; id: string }) => Promise<NextResponse> | NextResponse,
) =>
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) =>
    handler(async (c) => fn({ req: c.req, user: c.user, id: (await ctx.params).id }))(req);

export const DELETE = withId(async ({ req, user, id }) => {
  const session = await db.session.findUnique({ where: { id } });
  if (!session || session.userId !== user.id) throw Errors.notFound("Session not found.");

  const currentToken = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const isCurrent = !!currentToken && session.token === currentToken;
  await db.session.delete({ where: { id: session.id } });

  await audit({
    actorId: user.id, actorEmail: user.email,
    action: "SESSION_REVOKED", resourceType: "SESSION", resourceId: session.id,
    metadata: { self: isCurrent, hadAutoLogin: session.remember },
  });
  if (isCurrent) await clearSessionCookie();
  return ok({ revoked: true, current: isCurrent });
});
