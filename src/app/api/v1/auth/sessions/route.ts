// MOHD.HMS ENTERPRISE — Active session management (Profile → Security).
// GET /api/v1/auth/sessions — the CURRENT USER's own sessions (per device),
// with device/browser summary, last activity, IP, and the per-device Auto
// Login state. Own sessions only — no cross-user surface (admin-level session
// revocation stays in the existing User Management actions, which already
// delete ALL of a user's sessions).

import { handler, ok } from "@/lib/hms/api";
import { SESSION_COOKIE } from "@/lib/hms/auth";
import { db } from "@/lib/db";

/** Small user-agent summarizer for the session list (no fingerprinting —
 *  display only). */
function describeUa(ua: string | null): { browser: string; os: string } {
  if (!ua) return { browser: "Unknown browser", os: "Unknown OS" };
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Unknown browser";
  const os = /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "Unknown OS";
  return { browser, os };
}

export const GET = handler(async ({ req, user }) => {
  const currentToken = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const rows = await db.session.findMany({
    where: { userId: user.id },
    orderBy: { lastSeenAt: "desc" },
    take: 50,
  });
  const now = Date.now();
  return ok({
    sessions: rows.map((r) => {
      const { browser, os } = describeUa(r.userAgent);
      return {
        id: r.id,
        current: r.token === currentToken,
        device: `${browser} — ${os}`,
        autoLogin: r.remember,
        // Honest status: a remember-grant whose live credential was idle-
        // revoked shows as "Logged out (restorable)" — it is NOT an active
        // login; a fresh app open may restore it.
        status: r.idleRevokedAt ? "IDLE_REVOKED" : r.expiresAt.getTime() < now ? "EXPIRED" : "ACTIVE",
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      };
    }),
  });
});
