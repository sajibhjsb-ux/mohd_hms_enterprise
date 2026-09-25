import { handler, ok } from "@/lib/hms/api";
import { getSessionUser, consumeSessionRejectionReason } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { customerProfileState } from "@/lib/hms/customer-profile";
import { isAvatarRef } from "@/lib/hms/profile-photo";
import { termsStatusFor } from "@/lib/hms/legal/legal";

/** Session heartbeat. Sliding renewal happens server-side, silently — no reloads.
 *  The payload carries the derived, backend-authoritative profile completion
 *  state so the shell/dashboard can gate restricted customer actions, and the
 *  Terms & Conditions acceptance state so the consent gate stays accurate even
 *  when a new version is published mid-session. */
export const GET = handler(
  async ({ user }) => {
    if (!user) {
      // §28: the validation endpoint distinguishes WHY the session is not
      // active — REVOKED (superseded by another device), EXPIRED, or INVALID
      // (no/unknown cookie) — so clients can react precisely.
      const reason = consumeSessionRejectionReason();
      return ok({ authenticated: false, state: reason === "REVOKED" ? "REVOKED" : reason === "EXPIRED" ? "EXPIRED" : "INVALID" });
    }
    const [profileState, terms, avatar] = await Promise.all([
      customerProfileState(user),
      termsStatusFor(user),
      db.user.findUnique({ where: { id: user.id }, select: { avatarUrl: true } }),
    ]);
    // avatarUrl carries only valid storage keys — a legacy external URL is
    // delivered as null so clients render the default avatar, not a broken image.
    const storedAvatar = avatar?.avatarUrl ?? null;
    const avatarUrl = isAvatarRef(storedAvatar) ? storedAvatar : null;
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
    });
  },
  { auth: false }
);
