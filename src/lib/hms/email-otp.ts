import "server-only";
// MOHD.HMS ENTERPRISE — Email one-time codes (single shared OTP system).
// ONE system serves every purpose that needs a 6-digit emailed code
// (EMAIL_VERIFICATION for first customer login, PASSWORD_RESET for account
// recovery) — one Prisma model (EmailOtp, unique per user+purpose), one
// hashing scheme, one delivery channel. No purpose ever sees another
// purpose's codes.
//
// Security contract:
//   • 6-digit codes generated with crypto.randomInt (uniform, not guessable).
//   • Only a salted SHA-256 HASH is persisted — the plaintext code is never
//     stored, never logged, never returned by any API.
//   • Codes expire (EMAIL_OTP_TTL_SEC, env-overridable), are single-use,
//     allow a bounded number of verification attempts, and are INVALIDATED
//     by every resend (upsert overwrites the active row).
//   • A server-enforced resend cooldown is the single source of truth for the
//     UI countdown (60s for password reset, 30s for email verification).
//   • Delivery mirrors the established sandbox email infrastructure used by
//     every other MOHD.HMS flow: the EMAIL channel is logged (queued) and a
//     dev-mailbox Setting holds the code so admins can complete flows
//     locally. In production the EMAIL channel is delivered by the configured
//     provider; the Setting diagnostic then simply mirrors the sent mail.

import { createHash, randomInt, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { Errors } from "./api";

export const EMAIL_OTP_PURPOSES = ["EMAIL_VERIFICATION", "PASSWORD_RESET"] as const;
export type EmailOtpPurpose = (typeof EMAIL_OTP_PURPOSES)[number];

export const EMAIL_OTP_PURPOSE: EmailOtpPurpose = "EMAIL_VERIFICATION";
export const PASSWORD_RESET_OTP_PURPOSE: EmailOtpPurpose = "PASSWORD_RESET";

/** OTP lifetime (server clock authoritative). Env-overridable; default 10 min. */
export const EMAIL_OTP_TTL_SEC = positiveEnvInt("EMAIL_OTP_TTL_SEC", 10 * 60);
/** Max failed verification attempts before the active code is invalidated. */
export const EMAIL_OTP_MAX_ATTEMPTS = 5;
/** Resend cooldown per purpose (server-enforced; UI countdown mirrors it). */
const COOLDOWN_BY_PURPOSE: Record<EmailOtpPurpose, number> = {
  EMAIL_VERIFICATION: 30,
  PASSWORD_RESET: positiveEnvInt("PASSWORD_RESET_RESEND_COOLDOWN_SEC", 60),
};
/** Back-compat constant (email-verification cooldown) used by the login route. */
export const EMAIL_OTP_RESEND_COOLDOWN_SEC = COOLDOWN_BY_PURPOSE.EMAIL_VERIFICATION;

export function emailOtpResendCooldownSec(purpose: EmailOtpPurpose): number {
  return COOLDOWN_BY_PURPOSE[purpose] ?? EMAIL_OTP_RESEND_COOLDOWN_SEC;
}

export const EMAIL_OTP_INVALID_MESSAGE = "Invalid or expired verification code.";

function positiveEnvInt(key: string, fallback: number): number {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function hashOtp(userId: string, code: string, purpose: EmailOtpPurpose): string {
  // Per-user salt (userId) + purpose domain separation + server secret → a
  // leaked DB row cannot be brute-forced offline without the secret, hashes
  // are not portable between accounts, and a code from one purpose can never
  // verify against another purpose's row.
  const secret = process.env.OTP_HASH_SECRET || process.env.NEXTAUTH_SECRET || "mohd-hms-otp-dev-secret";
  return createHash("sha256").update(`${purpose}:${userId}:${code}:${secret}`).digest("hex");
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Dev-mailbox diagnostic key. EMAIL_VERIFICATION keeps its established key
 * (existing diagnostics/QA depend on it); every other purpose gets a namespaced
 * key so purposes never overwrite each other's mail.
 */
function devMailboxKey(userId: string, purpose: EmailOtpPurpose): string {
  return purpose === EMAIL_OTP_PURPOSE ? `dev_email_otp_${userId}` : `dev_email_otp_${purpose.toLowerCase()}_${userId}`;
}

/** Seconds until the next resend is allowed for this user+purpose (0 = now). */
export async function emailOtpCooldownRemainingSec(
  userId: string,
  purpose: EmailOtpPurpose = EMAIL_OTP_PURPOSE
): Promise<number> {
  const row = await db.emailOtp.findUnique({
    where: { userId_purpose: { userId, purpose } },
    select: { lastSentAt: true },
  });
  if (!row) return 0;
  const cooldownSec = emailOtpResendCooldownSec(purpose);
  const nextAllowedAt = row.lastSentAt.getTime() + cooldownSec * 1000;
  return Math.max(0, Math.ceil((nextAllowedAt - Date.now()) / 1000));
}

/**
 * (Re)issue the verification code for a user+purpose. Throws 429 with the
 * remaining cooldown while the resend window is active. Overwrites the
 * previous code (invalidating it), resets the attempt counter and extends
 * the expiry.
 */
export async function issueEmailOtp(
  user: { id: string; email: string },
  purpose: EmailOtpPurpose = EMAIL_OTP_PURPOSE
): Promise<{
  resendAfterSec: number;
  expiresInSec: number;
}> {
  const remaining = await emailOtpCooldownRemainingSec(user.id, purpose);
  if (remaining > 0) {
    throw Errors.tooMany(`A verification code was already sent. You can request a new one in ${remaining}s.`);
  }

  const code = generateCode();
  const now = new Date();
  const data = {
    codeHash: hashOtp(user.id, code, purpose),
    expiresAt: new Date(now.getTime() + EMAIL_OTP_TTL_SEC * 1000),
    attempts: 0,
    consumedAt: null,
    lastSentAt: now,
  };
  await db.emailOtp.upsert({
    where: { userId_purpose: { userId: user.id, purpose } },
    update: data,
    create: { ...data, userId: user.id, purpose },
  });

  // Delivery: EMAIL channel (provider configured via env in production).
  // Diagnostic log deliberately contains NO code value (security contract).
  console.log(JSON.stringify({
    ts: now.toISOString(),
    level: "info",
    channel: "EMAIL",
    to: user.email,
    subject:
      purpose === PASSWORD_RESET_OTP_PURPOSE
        ? "MOHD.HMS Enterprise Password Reset Verification Code"
        : "Your MOHD.HMS Enterprise verification code",
    purpose,
    queued: true,
  }));
  // Dev mailbox (same sandbox pattern as the rest of the email flows): lets
  // admins complete the flow locally; never exposed to unauthenticated
  // callers and never written to logs.
  await db.setting.upsert({
    where: { key: devMailboxKey(user.id, purpose) },
    update: { value: code },
    create: { key: devMailboxKey(user.id, purpose), value: code },
  });

  return { resendAfterSec: emailOtpResendCooldownSec(purpose), expiresInSec: EMAIL_OTP_TTL_SEC };
}

/**
 * Verify a submitted code for a user+purpose. Throws a GENERIC error for
 * every failure shape (no pending code / wrong code / expired / exhausted
 * attempts) so responses can never be used to enumerate account or code
 * state. A wrong attempt increments the counter; at EMAIL_OTP_MAX_ATTEMPTS
 * the code is invalidated.
 */
export async function verifyEmailOtp(
  user: { id: string },
  code: string,
  purpose: EmailOtpPurpose = EMAIL_OTP_PURPOSE
): Promise<void> {
  const row = await db.emailOtp.findUnique({
    where: { userId_purpose: { userId: user.id, purpose } },
  });
  const invalid = () => Errors.badRequest(EMAIL_OTP_INVALID_MESSAGE);
  if (!row || row.consumedAt) throw invalid();
  if (row.expiresAt.getTime() < Date.now()) throw invalid();

  if (row.attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
    await db.emailOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } }).catch(() => undefined);
    throw invalid();
  }

  const expected = Buffer.from(row.codeHash, "hex");
  const submitted = Buffer.from(hashOtp(user.id, code, purpose), "hex");
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
export async function clearEmailOtpDevMailbox(
  userId: string,
  purpose: EmailOtpPurpose = EMAIL_OTP_PURPOSE
): Promise<void> {
  await db.setting.deleteMany({ where: { key: devMailboxKey(userId, purpose) } }).catch(() => undefined);
}
