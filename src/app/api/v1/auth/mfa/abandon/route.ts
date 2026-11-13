import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { clearMfaCookie, hashMfaToken, MFA_COOKIE } from "@/lib/hms/mfa/challenge";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";

export const POST = handler(
  async ({ req }) => {
    assertMfaOrigin(req);
    const token = req.cookies.get(MFA_COOKIE)?.value;
    if (token) await db.mfaChallenge.deleteMany({ where: { tokenHash: hashMfaToken(token) } });
    const res = ok({ abandoned: true });
    clearMfaCookie(res);
    return res;
  },
  { auth: false }
);
