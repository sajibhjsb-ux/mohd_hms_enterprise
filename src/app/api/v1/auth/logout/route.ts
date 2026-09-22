import { handler, ok } from "@/lib/hms/api";
import {
  destroySession, clearSessionCookie, markSessionIdleRevoked, SESSION_COOKIE,
} from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";

export const POST = handler(
  async ({ req, user }) => {
    // Optional reason: the idle-session flow reports { reason: "idle" } so the
    // audit trail distinguishes inactivity auto-logout from a manual sign-out.
    // The body is optional — a plain logout POST behaves exactly as before.
    let reason: string | null = null;
    try {
      const raw = (await req.json()) as { reason?: unknown } | null;
      reason = typeof raw?.reason === "string" ? raw.reason : null;
    } catch { /* no body — manual logout */ }

    if (user) {
      await audit({ actorId: user.id, actorEmail: user.email, action: "LOGOUT", resourceType: "AUTH" });
      if (reason === "idle") {
        // Inactivity auto-logout initiated by the client (the server-side lazy
        // path records the same action when the NEXT request finds the session
        // idle-expired). Metadata only — never tokens or secrets.
        await audit({
          actorId: user.id, actorEmail: user.email,
          action: "SESSION_EXPIRED_IDLE_TIMEOUT", resourceType: "SESSION",
          metadata: { initiatedBy: "client", idleTimeout: true },
        });
      }
    }

    // USER-CONTROLLED AUTO LOGIN: an inactivity logout on a remember-grant
    // ("Keep me signed in on this device") revokes the LIVE credential while
    // preserving the grant row, so a genuinely fresh app open can restore the
    // session through the validated restore endpoint (token rotation). A
    // MANUAL logout — no reason, or any reason other than "idle" — always
    // destroys the grant: explicit sign-out is more authoritative than
    // persistence and the user is never silently logged back in.
    let idleMarked = false;
    if (reason === "idle") {
      const token = req.cookies.get(SESSION_COOKIE)?.value;
      if (token) idleMarked = await markSessionIdleRevoked(token);
    }
    if (idleMarked) await clearSessionCookie();
    else await destroySession();
    return ok({ loggedOut: true });
  },
  { auth: false }
);
