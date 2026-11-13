import { z } from "zod";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import {
  getSessionUser,
  createSupersedingSession,
  setSessionCookie,
  SESSION_TTL_MS,
  SESSION_REMEMBER_TTL_MS,
} from "@/lib/hms/auth";
import { clientIp } from "@/lib/hms/rate-limit";
import { clearMfaCookie, consumeMfaChallenge, readMfaChallenge } from "@/lib/hms/mfa/challenge";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { confirmEnrollment } from "@/lib/hms/mfa/enrollment";

const schema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const POST = handler(
  async ({ req }) => {
    assertMfaOrigin(req);
    const { code } = await parseBody(req, schema);
    const ip = clientIp(req);
    const live = await getSessionUser();
    const challengeContext = live ? null : await readMfaChallenge(req, "ENROLL");
    const user = live ?? challengeContext?.user;
    if (!user) throw Errors.unauthorized("Sign in again to continue.");

    const { recoveryCodes } = await confirmEnrollment(user.id, code, ip);

    if (challengeContext) {
      const consumed = await consumeMfaChallenge(challengeContext.challenge.id);
      if (!consumed) throw Errors.badRequest("Invalid verification code.");
      const { token, expiresAt } = await createSupersedingSession(
        user.id,
        ip,
        req.headers.get("user-agent") ?? undefined,
        challengeContext.challenge.remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS,
        challengeContext.challenge.remember
      );
      await setSessionCookie(token, expiresAt);
    }

    const res = ok({ recoveryCodes });
    clearMfaCookie(res);
    return res;
  },
  { auth: false }
);
