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
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { consumeRecoveryCode } from "@/lib/hms/mfa/recovery";

const schema = z.object({ code: z.string().min(8) });
const EXPIRED = "This verification window expired. Please sign in again.";

export const POST = handler(
  async ({ req }) => {
    assertMfaOrigin(req);
    const context = await readMfaChallenge(req, "LOGIN");
    if (!context) throw Errors.badRequest(EXPIRED);

    const ip = clientIp(req);
    const rl = rateLimit(`mfa-recovery:${ip}:${context.user.id}`, 5, 15 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany(`Too many recovery attempts. Try again in ${rl.retryAfterSec}s.`);

    const { code } = await parseBody(req, schema);
    const consumed = await consumeRecoveryCode(context.user.id, code, ip);
    if (!consumed) {
      await registerMfaFailure(context.challenge.id);
      await audit({
        actorId: context.user.id,
        actorEmail: context.user.email,
        action: "MFA_VERIFY_FAILED",
        resourceType: "AUTH",
        ip,
        metadata: { method: "RECOVERY" },
      });
      throw Errors.badRequest("Invalid verification code.");
    }

    await db.$transaction(async (tx) => {
      if (!(await consumeMfaChallenge(context.challenge.id, tx))) throw Errors.badRequest(EXPIRED);
      await tx.userMfa.update({
        where: { userId: context.user.id },
        data: { lastRecoveryAt: new Date(), lastVerifiedAt: new Date() },
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
    await audit({ actorId: context.user.id, actorEmail: context.user.email, action: "MFA_RECOVERY_USED", resourceType: "AUTH", ip });
    await notify({
      userId: context.user.id,
      title: "Recovery code used",
      message: "A recovery code was used to sign in to your account. If this was not you, change your password and reset two-factor authentication immediately.",
      type: "WARNING",
      channels: ["IN_APP", "EMAIL"],
    });

    const res = ok({ mfaVerified: true });
    clearMfaCookie(res);
    return res;
  },
  { auth: false }
);
