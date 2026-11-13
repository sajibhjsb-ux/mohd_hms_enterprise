import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { getSessionUser } from "@/lib/hms/auth";
import { clientIp, rateLimit } from "@/lib/hms/rate-limit";
import { readMfaChallenge } from "@/lib/hms/mfa/challenge";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { startEnrollment } from "@/lib/hms/mfa/enrollment";

export const POST = handler(
  async ({ req }) => {
    assertMfaOrigin(req);
    const live = await getSessionUser();
    const challengeContext = live ? null : await readMfaChallenge(req, "ENROLL");
    const user = live ?? challengeContext?.user;
    if (!user) throw Errors.unauthorized("Sign in again to continue.");

    const ip = clientIp(req);
    const rl = rateLimit(`mfa-enroll:${user.id}`, 5, 60 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany(`Too many enrolment attempts. Try again in ${rl.retryAfterSec}s.`);

    const existing = await db.userMfa.findUnique({ where: { userId: user.id } });
    if (existing?.mfaEnabled) throw Errors.conflict("MFA is already enabled. Use re-enrol to replace the authenticator.");

    return ok(await startEnrollment(user));
  },
  { auth: false }
);
