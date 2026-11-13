import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import {
  createSupersedingSession,
  setSessionCookie,
  SESSION_TTL_MS,
  SESSION_REMEMBER_TTL_MS,
} from "@/lib/hms/auth";
import { clientIp, rateLimit } from "@/lib/hms/rate-limit";
import { audit, notify } from "@/lib/hms/services";
import {
  clearMfaCookie,
  consumeMfaChallenge,
  readMfaChallenge,
  registerMfaFailure,
} from "@/lib/hms/mfa/challenge";
import { decryptSecret } from "@/lib/hms/mfa/crypto";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { verifyTotp } from "@/lib/hms/mfa/totp";

const schema = z.object({ code: z.string().regex(/^\d{6}$/) });
const EXPIRED = "This verification window expired. Please sign in again.";

export const POST = handler(
  async ({ req }) => {
    assertMfaOrigin(req);
    const context = await readMfaChallenge(req, "LOGIN");
    if (!context) throw Errors.badRequest(EXPIRED);

    const ip = clientIp(req);
    const rl = rateLimit(`mfa-verify:${ip}:${context.user.id}`, 10, 5 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany(`Too many verification attempts. Try again in ${rl.retryAfterSec}s.`);

    const { code } = await parseBody(req, schema);
    const mfa = await db.userMfa.findUnique({ where: { userId: context.user.id } });
    if (!mfa?.mfaEnabled || !mfa.encryptedTotpSecret) throw Errors.badRequest("Invalid verification code.");

    const result = await verifyTotp(decryptSecret(mfa.encryptedTotpSecret, context.user.id), code, mfa.lastTotpStep);
    if (!result.valid) {
      const remaining = await registerMfaFailure(context.challenge.id);
      if (remaining === 0) {
        await notify({
          userId: context.user.id,
          title: "Repeated MFA verification failures",
          message: "Someone entered an incorrect two-factor code several times. If this was not you, change your password immediately.",
          type: "WARNING",
          channels: ["IN_APP", "EMAIL"],
        });
      }
      await audit({
        actorId: context.user.id,
        actorEmail: context.user.email,
        action: "MFA_VERIFY_FAILED",
        resourceType: "AUTH",
        ip,
        metadata: { method: "TOTP", remainingAttempts: remaining },
      });
      throw Errors.badRequest("Invalid verification code.");
    }

    const timeStep = result.timeStep ?? Math.floor(Date.now() / 1000);
    await db.$transaction(async (tx) => {
      if (!(await consumeMfaChallenge(context.challenge.id, tx))) throw Errors.badRequest(EXPIRED);
      await tx.userMfa.update({
        where: { userId: context.user.id },
        data: { lastTotpStep: timeStep, lastVerifiedAt: new Date() },
      });
    });

    const remember = context.challenge.remember;
    const { token, expiresAt } = await createSupersedingSession(
      context.user.id,
      ip,
      req.headers.get("user-agent") ?? undefined,
      remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS,
      remember
    );
    await setSessionCookie(token, expiresAt);
    await audit({ actorId: context.user.id, actorEmail: context.user.email, action: "MFA_VERIFIED", resourceType: "AUTH", ip, metadata: { method: "TOTP" } });

    const res = ok({ mfaVerified: true });
    clearMfaCookie(res);
    return res;
  },
  { auth: false }
);
