// POST /api/v1/auth/forgot-password/verify-otp — step 2 of password recovery.
// Verifies the 6-digit PASSWORD_RESET OTP through the EXISTING shared
// email-OTP system and, on success, issues a SHORT-LIVED, SINGLE-USE reset
// authorization (48 random bytes; only its SHA-256 hash is stored in the
// existing PasswordResetToken table). The authorization grants ONLY the
// ability to set a new password — it is not a session, grants no dashboard /
// portal / API / role access, and is retired the moment it is used, when it
// expires, or when a newer recovery request supersedes it.
// Every failure shape returns the SAME generic message so the endpoint can
// never be used to enumerate accounts, codes or authorization state.

import { NextRequest } from "next/server";
import { z } from "zod";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { generateToken } from "@/lib/hms/auth";
import {
  verifyEmailOtp,
  EMAIL_OTP_INVALID_MESSAGE,
  PASSWORD_RESET_OTP_PURPOSE,
} from "@/lib/hms/email-otp";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";

/** Reset-authorization lifetime (server clock authoritative). Env-overridable. */
export const PASSWORD_RESET_AUTHORIZATION_TTL_SEC = (() => {
  const raw = Number(process.env.PASSWORD_RESET_AUTHORIZATION_TTL_SEC);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10 * 60; // 10 min
})();

const schema = z.object({
  email: z.string().email("Enter a valid email address."),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit verification code."),
});

function hashResetToken(token: string): string {
  // Server secret domain-separates the hash: a leaked DB row cannot be
  // replayed and the plaintext authorization never touches storage or logs.
  const secret = process.env.OTP_HASH_SECRET || process.env.NEXTAUTH_SECRET || "mohd-hms-otp-dev-secret";
  return createHash("sha256").update(`PASSWORD_RESET_AUTH:${token}:${secret}`).digest("hex");
}

export const POST = handler(
  async ({ req }) => {
    const ip = clientIp(req);
    const { email: rawEmail, code } = await parseBody(req, schema);
    const email = rawEmail.trim().toLowerCase();

    // Attempt throttling independent of the request limiter.
    const rl = rateLimit(`pwreset-verify:${ip}:${email}`, 12, 5 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany();

    const user = await db.user.findUnique({ where: { email } });
    const applicable = user && user.status === "ACTIVE";
    if (!applicable) {
      await audit({ action: "PASSWORD_RESET_FAILED", resourceType: "AUTH", metadata: { email, reason: "verify_otp" }, ip });
      throw Errors.badRequest(EMAIL_OTP_INVALID_MESSAGE);
    }

    // Throws the same generic error on wrong/expired/exhausted codes.
    await verifyEmailOtp(user, code, PASSWORD_RESET_OTP_PURPOSE);

    // Issue the one-time reset authorization tied to THIS verified request.
    // Any earlier authorization for the account is retired first — exactly
    // one active authorization per user (multi-tab safety).
    const resetToken = generateToken();
    await db.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await db.passwordResetToken.create({
      data: {
        token: hashResetToken(resetToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_AUTHORIZATION_TTL_SEC * 1000),
      },
    });
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PASSWORD_RESET_OTP_VERIFIED",
      resourceType: "AUTH",
      ip,
    });

    // The plaintext authorization is returned exactly once and lives in
    // client memory only (never in URLs, storage or logs).
    return ok({ resetToken, expiresInSec: PASSWORD_RESET_AUTHORIZATION_TTL_SEC });
  },
  { auth: false }
);
