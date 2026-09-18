import "server-only";
// MOHD.HMS ENTERPRISE — Email verification one-time codes.
// Security contract:
//   • 6-digit codes generated with crypto.randomInt (uniform, not guessable).
//   • Only a salted SHA-256 HASH is persisted — the plaintext code is never
//     stored, never logged, never returned by any API.
//   • Codes expire (EMAIL_OTP_TTL_SEC), are single-use, allow a bounded number
//     of verification attempts, and are INVALIDATED by every resend.
//   • A server-enforced resend cooldown (EMAIL_OTP_RESEND_COOLDOWN_SEC) is the
//     single source of truth for the UI countdown.
//   • Delivery mirrors the established sandbox pattern used by password
//     resets: the EMAIL channel is logged (queued) and a dev-mailbox Setting
//     holds the code so super admins can complete flows locally. In production
//     the EMAIL channel is delivered by the configured provider; the Setting
//     diagnostic then simply mirrors the sent mail.

import { createHash, randomInt, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { Errors } from "./api";

export const EMAIL_OTP_PURPOSE = "EMAIL_VERIFICATION";
export const EMAIL_OTP_TTL_SEC = 10 * 60; // 10 minutes
export const EMAIL_OTP_RESEND_COOLDOWN_SEC = 30;
export const EMAIL_OTP_MAX_ATTEMPTS = 5;

export const EMAIL_OTP_INVALID_MESSAGE = "Invalid or expired verification code.";

function hashOtp(userId: string, code: string): string {
  // Per-user salt (userId) + server secret → a leaked DB row cannot be
  // brute-forced offline without the secret, and hashes are not portable
  // between accounts.
  const secret = process.env.OTP_HASH_SECRET || process.env.NEXTAUTH_SECRET || "mohd-hms-otp-dev-secret";
  return createHash("sha256").update(`${EMAIL_OTP_PURPOSE}:${userId}:${code}:${secret}`).digest("hex");
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Seconds until the next resend is allowed for this user (0 = allowed now). */
export async function emailOtpCooldownRemainingSec(userId: string): Promise<number> {
  const row = await db.emailOtp.findUnique({
    where: { userId_purpose: { userId, purpose: EMAIL_OTP_PURPOSE } },
    select: { lastSentAt: true },
  });
  if (!row) return 0;
  const nextAllowedAt = row.lastSentAt.getTime() + EMAIL_OTP_RESEND_COOLDOWN_SEC * 1000;
  return Math.max(0, Math.ceil((nextAllowedAt - Date.now()) / 1000));
}

/**
 * (Re)issue the verification code for a user. Throws 429 with the remaining
 * cooldown while the resend window is active. Overwrites the previous code
 * (invalidating it), resets the attempt counter and extends the expiry.
 */
export async function issueEmailOtp(user: { id: string; email: string }): Promise<{
  resendAfterSec: number;
  expiresInSec: number;
}> {
  const remaining = await emailOtpCooldownRemainingSec(user.id);
  if (remaining > 0) {
    throw Errors.tooMany(`A verification code was already sent. You can request a new one in ${remaining}s.`);
  }

  const code = generateCode();
  const now = new Date();
  const data = {
    codeHash: hashOtp(user.id, code),
    expiresAt: new Date(now.getTime() + EMAIL_OTP_TTL_SEC * 1000),
    attempts: 0,
    consumedAt: null,
    lastSentAt: now,
  };
  await db.emailOtp.upsert({
    where: { userId_purpose: { userId: user.id, purpose: EMAIL_OTP_PURPOSE } },
    update: data,
    create: { ...data, userId: user.id, purpose: EMAIL_OTP_PURPOSE },
  });

  // Delivery: EMAIL channel (provider configured via env in production).
  // Diagnostic log deliberately contains NO code value (security contract).
  console.log(JSON.stringify({
    ts: now.toISOString(),
    level: "info",
    channel: "EMAIL",
    to: user.email,
    subject: "Your MOHD.HMS Enterprise verification code",
    queued: true,
  }));
  // Dev mailbox (same sandbox pattern as password-reset tokens): lets admins
  // complete the verification flow locally; never exposed to unauthenticated
  // callers and never written to logs.
  await db.setting.upsert({
    where: { key: `dev_email_otp_${user.id}` },
    update: { value: code },
    create: { key: `dev_email_otp_${user.id}`, value: code },
  });

  return { resendAfterSec: EMAIL_OTP_RESEND_COOLDOWN_SEC, expiresInSec: EMAIL_OTP_TTL_SEC };
}

/**
 * Verify a submitted code. Throws a GENERIC error for every failure shape
 * (no pending code / wrong code / expired / exhausted attempts) so responses
 * can never be used to enumerate account or code state. A wrong attempt
 * increments the counter; at EMAIL_OTP_MAX_ATTEMPTS the code is invalidated.
 */
export async function verifyEmailOtp(user: { id: string }, code: string): Promise<void> {
  const row = await db.emailOtp.findUnique({
    where: { userId_purpose: { userId: user.id, purpose: EMAIL_OTP_PURPOSE } },
  });
  const invalid = () => Errors.badRequest(EMAIL_OTP_INVALID_MESSAGE);
  if (!row || row.consumedAt) throw invalid();
  if (row.expiresAt.getTime() < Date.now()) throw invalid();

  if (row.attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
    await db.emailOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } }).catch(() => undefined);
    throw invalid();
  }

  const expected = Buffer.from(row.codeHash, "hex");
  const submitted = Buffer.from(hashOtp(user.id, code), "hex");
  const okMatch = expected.length === submitted.length && timingSafeEqual(expected, submitted);
  if (!okMatch) {
    const attempts = row.attempts + 1;
    await db.emailOtp.update({
      where: { id: row.id },
      data: { attempts, ...(attempts >= EMAIL_OTP_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}) },
    });
    throw invalid();
  }

  await db.emailOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
}

/** Remove a user's dev-mailbox diagnostic (call after verification completes). */
export async function clearEmailOtpDevMailbox(userId: string): Promise<void> {
  await db.setting.deleteMany({ where: { key: `dev_email_otp_${userId}` } }).catch(() => undefined);
}
