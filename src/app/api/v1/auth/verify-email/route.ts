// POST /api/v1/auth/verify-email — verify the 6-digit email OTP issued at
// login for customer accounts without a verified email. On success the email
// is marked verified (one-time step), a normal session is opened and the
// standard SessionUser payload is returned — the client then continues to the
// existing authenticated destination (dashboard / profile completion banner).
// Every failure shape returns the SAME generic message so the endpoint can
// never be used to enumerate accounts or code state.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { createSession, setSessionCookie, SESSION_TTL_MS, SESSION_REMEMBER_TTL_MS } from "@/lib/hms/auth";
import { can } from "@/lib/hms/rbac";
import { customerProfileState } from "@/lib/hms/customer-profile";
import { termsStatusFor } from "@/lib/hms/legal/legal";
import { verifyEmailOtp, clearEmailOtpDevMailbox, EMAIL_OTP_INVALID_MESSAGE } from "@/lib/hms/email-otp";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";
import type { Permission } from "@/lib/hms/constants";

const schema = z.object({
  email: z.string().email("Enter a valid email address."),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit verification code."),
  remember: z.boolean().optional(),
});

export const POST = handler(
  async ({ req }) => {
    const ip = clientIp(req);
    const { email, code, remember } = await parseBody(req, schema);

    // Attempt throttling independent of the login limiter.
    const rl = rateLimit(`verify-email:${ip}:${email.toLowerCase()}`, 12, 5 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany();

    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    const applicable = user && user.status === "ACTIVE" && user.role === "CUSTOMER" && !user.emailVerified;
    if (!applicable) {
      await audit({ action: "EMAIL_VERIFICATION_FAILED", resourceType: "AUTH", metadata: { email }, ip });
      throw Errors.badRequest(EMAIL_OTP_INVALID_MESSAGE);
    }

    // Throws the same generic error on wrong/expired/exhausted codes.
    await verifyEmailOtp(user, code);

    await db.user.update({
      where: { id: user.id },
      data: { emailVerified: new Date(), lastLoginAt: new Date() },
    });
    const { token, expiresAt } = await createSession(
      user.id,
      ip,
      req.headers.get("user-agent") ?? undefined,
      remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS
    );
    await setSessionCookie(token, expiresAt);
    await clearEmailOtpDevMailbox(user.id);
    await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_VERIFIED", resourceType: "AUTH", ip });

    // Same payload shape as the login response — one client contract.
    const profileState = await customerProfileState(user);
    const terms = await termsStatusFor(user);
    const res = NextResponse.json({
      ok: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        customerId: user.customerId,
        permissions: can(user.role as never),
        profileComplete: profileState.profileComplete,
        missingFields: profileState.missingFields,
        terms,
      },
    });
    res.headers.set("x-session-expires-at", expiresAt.toISOString());
    return res;
  },
  { auth: false }
);
