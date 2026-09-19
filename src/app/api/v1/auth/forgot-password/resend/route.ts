// POST /api/v1/auth/forgot-password/resend — re-issue the PASSWORD_RESET OTP
// (invalidates the previous code) through the EXISTING shared email-OTP
// system. The resend cooldown is enforced HERE (server-authoritative); the
// UI countdown is driven by the returned resendAfterSec so it always matches
// the backend. Responses keep an identical envelope whether or not the
// account is actually eligible — the endpoint can never be used to probe
// which emails exist.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import {
  issueEmailOtp,
  emailOtpResendCooldownSec,
  EMAIL_OTP_TTL_SEC,
  PASSWORD_RESET_OTP_PURPOSE,
} from "@/lib/hms/email-otp";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";

const schema = z.object({ email: z.string().email("Enter a valid email address.") });

export const POST = handler(
  async ({ req }) => {
    const ip = clientIp(req);
    const { email: rawEmail } = await parseBody(req, schema);
    const email = rawEmail.trim().toLowerCase();

    const rl = rateLimit(`pwreset-resend:${ip}:${email}`, 5, 15 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany();

    const user = await db.user.findUnique({ where: { email } });
    const applicable = user && user.status === "ACTIVE";

    if (applicable) {
      // May throw 429 with the true remaining cooldown while the window is active.
      const issued = await issueEmailOtp(user, PASSWORD_RESET_OTP_PURPOSE);
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PASSWORD_RESET_OTP_RESENT",
        resourceType: "AUTH",
        ip,
      });
      return ok({ resent: true, resendAfterSec: issued.resendAfterSec, expiresInSec: issued.expiresInSec });
    }

    // Not applicable — identical envelope, no state change, no enumeration.
    return ok({
      resent: true,
      resendAfterSec: emailOtpResendCooldownSec(PASSWORD_RESET_OTP_PURPOSE),
      expiresInSec: EMAIL_OTP_TTL_SEC,
    });
  },
  { auth: false }
);
