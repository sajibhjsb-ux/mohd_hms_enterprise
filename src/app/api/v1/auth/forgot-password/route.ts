// POST /api/v1/auth/forgot-password — step 1 of the password recovery flow.
// Verifies recovery eligibility and (for eligible accounts) issues a 6-digit
// PASSWORD_RESET OTP through the EXISTING shared email-OTP system
// (EmailOtp model, hashed codes, resend cooldown) and the established EMAIL
// delivery channel. This supersedes the legacy link-token flow, which had no
// consuming UI — the required journey is Email → OTP → New Password.
//
// ANTI-ENUMERATION: the response envelope is byte-identical whether or not
// the email exists / is eligible. No user id, role, status or classification
// is ever revealed. Requests are rate-limited per IP and per IP+email, and
// a request issued while the resend cooldown is active reuses the pending
// code instead of sending another one (no mail-bombing, no 429 surprise on
// double-tap of Continue).

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/hms/api";
import {
  emailOtpCooldownRemainingSec,
  emailOtpResendCooldownSec,
  issueEmailOtp,
  EMAIL_OTP_TTL_SEC,
  PASSWORD_RESET_OTP_PURPOSE,
} from "@/lib/hms/email-otp";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";

export const PASSWORD_RESET_GENERIC_MESSAGE =
  "If an account is eligible for password recovery, a verification code has been sent.";

const schema = z.object({ email: z.string().email("Enter a valid email address.") });

/** Per-IP request budget (15 min window). Env-tunable like the OTP knobs; default 5. */
const REQUEST_LIMIT_PER_IP = (() => {
  const raw = Number(process.env.PWRESET_REQUEST_LIMIT_PER_IP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
})();
const REQUEST_LIMIT_PER_IP_EMAIL = 3;

export const POST = handler(
  async ({ req }) => {
    const ip = clientIp(req);
    const { email: rawEmail } = await parseBody(req, schema);
    const email = rawEmail.trim().toLowerCase();

    // Rate limit: 5 requests / 15 min per IP (env-tunable), and 3 / 15 min per IP+email.
    if (!rateLimit(`pwreset-req:${ip}`, REQUEST_LIMIT_PER_IP, 15 * 60 * 1000).allowed) {
      return forgotPasswordResponse();
    }
    if (!rateLimit(`pwreset-req:${ip}:${email}`, REQUEST_LIMIT_PER_IP_EMAIL, 15 * 60 * 1000).allowed) {
      return forgotPasswordResponse();
    }

    const user = await db.user.findUnique({ where: { email } });

    if (user && user.status === "ACTIVE") {
      // A pending code within its resend window is REUSED (same contract as
      // the login OTP challenge) so double submissions never send extra mail.
      const cooldown = await emailOtpCooldownRemainingSec(user.id, PASSWORD_RESET_OTP_PURPOSE);
      if (cooldown > 0) {
        return forgotPasswordResponse(cooldown);
      }

      // Issues a fresh code, invalidating any previous one; also retires any
      // outstanding reset authorization so exactly ONE recovery context per
      // account is alive at a time (multi-tab safety: newest request wins).
      await issueEmailOtp(user, PASSWORD_RESET_OTP_PURPOSE);
      await db.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PASSWORD_RESET_REQUESTED",
        resourceType: "AUTH",
        ip,
      });
    }

    // Identical shape and message for every caller — no account signal.
    return forgotPasswordResponse();
  },
  { auth: false }
);

/** The one and only public response for this endpoint. */
function forgotPasswordResponse(pendingCooldownSec = 0) {
  return ok({
    message: PASSWORD_RESET_GENERIC_MESSAGE,
    resendAfterSec: pendingCooldownSec || emailOtpResendCooldownSec(PASSWORD_RESET_OTP_PURPOSE),
    expiresInSec: EMAIL_OTP_TTL_SEC,
  });
}
