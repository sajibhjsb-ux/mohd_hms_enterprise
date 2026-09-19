// POST /api/v1/auth/resend-verification — re-issue the email verification OTP
// (invalidates the previous code). The resend cooldown is enforced HERE
// (server-authoritative); the UI countdown is driven by the returned
// resendAfterSec so it always matches the backend. Responses keep an
// identical shape whether or not the account is actually pending
// verification — the endpoint can never be used to probe which emails exist.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { issueEmailOtp, EMAIL_OTP_RESEND_COOLDOWN_SEC, EMAIL_OTP_TTL_SEC } from "@/lib/hms/email-otp";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";

const schema = z.object({ email: z.string().email("Enter a valid email address.") });

export const POST = handler(
  async ({ req }) => {
    const ip = clientIp(req);
    const { email } = await parseBody(req, schema);

    const rl = rateLimit(`resend-otp:${ip}:${email.toLowerCase()}`, 5, 15 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany();

    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    const applicable = user && user.status === "ACTIVE" && user.role === "CUSTOMER" && !user.emailVerified;

    if (applicable) {
      // May throw 429 with the true remaining cooldown while the window is active.
      const issued = await issueEmailOtp(user);
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "EMAIL_OTP_RESENT",
        resourceType: "AUTH",
        ip,
      });
      return ok({ resent: true, resendAfterSec: issued.resendAfterSec, expiresInSec: issued.expiresInSec });
    }

    // Not applicable — identical envelope, no state change, no enumeration.
    return ok({ resent: true, resendAfterSec: EMAIL_OTP_RESEND_COOLDOWN_SEC, expiresInSec: EMAIL_OTP_TTL_SEC });
  },
  { auth: false }
);
