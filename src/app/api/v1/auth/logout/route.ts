import { handler, ok } from "@/lib/hms/api";
import { destroySession, getSessionUser } from "@/lib/hms/auth";
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
    await destroySession();
    return ok({ loggedOut: true });
  },
  { auth: false }
);
