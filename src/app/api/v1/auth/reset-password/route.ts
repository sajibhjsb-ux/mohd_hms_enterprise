// POST /api/v1/auth/reset-password — final step of password recovery.
// Consumes the SHORT-LIVED, SINGLE-USE reset authorization issued after the
// PASSWORD_RESET OTP was verified (POST /api/v1/auth/forgot-password/verify-otp).
// The route can NOT be reached legitimately without that server-side
// authorization — a manually visited screen or a forged token fails here.
//
// The reset is ATOMIC: password hash update, authorization consumption,
// revocation of every existing session for the account and dev-mailbox
// cleanup all commit together (or not at all). The response stays generic
// for every failure shape — no token state, account state or internals leak.
// Plaintext passwords/authorizations are never stored, logged or returned.

import { NextRequest } from "next/server";
import { z } from "zod";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { hashPassword, validatePasswordStrength } from "@/lib/hms/auth";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";

export const PASSWORD_RESET_NO_LONGER_VALID_MESSAGE =
  "This password reset request is no longer valid. Please start again.";

const schema = z.object({
  resetToken: z.string().min(10),
  password: z.string().min(1),
  confirmPassword: z.string().min(1),
});

function hashResetToken(token: string): string {
  // MUST mirror verify-otp: same secret, same domain separator.
  const secret = process.env.OTP_HASH_SECRET || process.env.NEXTAUTH_SECRET || "mohd-hms-otp-dev-secret";
  return createHash("sha256").update(`PASSWORD_RESET_AUTH:${token}:${secret}`).digest("hex");
}

export const POST = handler(
  async ({ req }) => {
    const ip = clientIp(req);
    const rl = rateLimit(`pwreset-use:${ip}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany();

    const { resetToken, password, confirmPassword } = await parseBody(req, schema);

    // Server-side confirmation (never trust the client) — checked before any
    // expensive work so a mismatch can never reach the transaction.
    if (password !== confirmPassword) {
      throw Errors.badRequest("Passwords do not match.");
    }

    // EXISTING password policy — not weakened, not duplicated.
    const strengthError = validatePasswordStrength(password);
    if (strengthError) throw Errors.badRequest(strengthError);

    const reset = await db.passwordResetToken.findUnique({ where: { token: hashResetToken(resetToken) } });
    if (!reset || reset.usedAt || reset.expiresAt.getTime() < Date.now()) {
      await audit({ action: "PASSWORD_RESET_FAILED", resourceType: "AUTH", metadata: { reason: "invalid_authorization" }, ip });
      throw Errors.badRequest(PASSWORD_RESET_NO_LONGER_VALID_MESSAGE);
    }

    const passwordHash = await hashPassword(password);

    // ATOMIC reset: new hash + authorization consumed + ALL sessions revoked
    // (existing security architecture: old logins cannot survive a password
    // change) + sandbox diagnostics cleaned. Any failure rolls everything back.
    const consumed = await db.$transaction(async (tx) => {
      // Single-use enforcement INSIDE the transaction: the token is consumed
      // with a conditional update (usedAt IS NULL, still valid) — a raced
      // second request finds zero rows, aborts the whole reset and can never
      // overwrite the first result with a different password.
      const claim = await tx.passwordResetToken.updateMany({
        where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claim.count !== 1) {
        throw Errors.badRequest(PASSWORD_RESET_NO_LONGER_VALID_MESSAGE);
      }
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: reset.userId } });
      // Legacy diagnostics from the superseded link-token flow + this flow's OTP.
      await tx.setting.deleteMany({ where: { key: `dev_pwreset_${reset.userId}` } });
      await tx.setting.deleteMany({ where: { key: `dev_email_otp_password_reset_${reset.userId}` } });
      return true;
    });
    void consumed;

    await audit({
      actorId: reset.userId,
      action: "PASSWORD_RESET_COMPLETED",
      resourceType: "AUTH",
      resourceId: reset.userId,
      ip,
    });

    // No auto-login: the user returns to Login and signs in with the new
    // password (the session cookie was revoked with the transaction).
    return ok({ message: "Password updated. You can now sign in." });
  },
  { auth: false }
);
