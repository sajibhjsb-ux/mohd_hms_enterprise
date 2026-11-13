// MOHD.HMS ENTERPRISE — Explicit sign-out.
// Destroys the current session row (including any Auto Login grant — an
// explicit logout always wins over persistence) and clears the cookie.

import { handler, ok } from "@/lib/hms/api";
import { destroySession } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";
import { clearMfaCookie } from "@/lib/hms/mfa/challenge";

export const POST = handler(
  async ({ user }) => {
    if (user) {
      await audit({ actorId: user.id, actorEmail: user.email, action: "LOGOUT", resourceType: "AUTH" });
    }
    await destroySession();
    const res = ok({ loggedOut: true });
    clearMfaCookie(res);
    return res;
  },
  { auth: false }
);
