import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import {
  verifyPassword,
  createSession,
  setSessionCookie,
  SESSION_TTL_MS,
  SESSION_REMEMBER_TTL_MS,
} from "@/lib/hms/auth";
import { can } from "@/lib/hms/rbac";
import { customerProfileState } from "@/lib/hms/customer-profile";
import {
  emailOtpCooldownRemainingSec,
  issueEmailOtp,
  EMAIL_OTP_TTL_SEC,
} from "@/lib/hms/email-otp";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";
import type { Permission } from "@/lib/hms/constants";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
  // "Remember me" extends the session from the default 7 days to 30 days.
  // Absent/false keeps the existing behavior byte-identical.
  remember: z.boolean().optional(),
});

export const POST = handler(
  async ({ req }) => {
    const ip = clientIp(req);
    const { email, password, remember } = await parseBody(req, loginSchema);

    // Rate limit: 8 attempts / 5 min per IP+email
    const rl = rateLimit(`login:${ip}:${email.toLowerCase()}`, 8, 5 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany(`Too many login attempts. Try again in ${rl.retryAfterSec}s.`);

    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    const valid = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !valid) {
      await audit({ action: "LOGIN_FAILED", resourceType: "AUTH", metadata: { email }, ip });
      throw Errors.unauthorized("Invalid email or password.");
    }
    if (user.status !== "ACTIVE") throw Errors.forbidden("Your account has been disabled. Contact your administrator.");

    // Customer accounts provisioned without a verified email must verify it
    // once via a 6-digit email OTP before a session is issued (staff accounts
    // and already-verified customers — including seed and Google accounts —
    // are unaffected and never see this step). During the resend cooldown a
    // pending code is reused instead of erroring, so tapping Log In again
    // simply returns to the verification screen with the true countdown.
    if (user.role === "CUSTOMER" && !user.emailVerified) {
      const cooldown = await emailOtpCooldownRemainingSec(user.id);
      const issued =
        cooldown > 0
          ? { resendAfterSec: cooldown, expiresInSec: EMAIL_OTP_TTL_SEC }
          : await issueEmailOtp(user);
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "EMAIL_OTP_ISSUED",
        resourceType: "AUTH",
        ip,
      });
      return ok({
        otpRequired: true,
        email: user.email,
        resendAfterSec: issued.resendAfterSec,
        expiresInSec: issued.expiresInSec,
      });
    }

    const { token, expiresAt } = await createSession(
      user.id,
      ip,
      req.headers.get("user-agent") ?? undefined,
      remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS
    );
    await setSessionCookie(token, expiresAt);
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit({ actorId: user.id, actorEmail: user.email, action: "LOGIN", resourceType: "AUTH", ip });

    // Profile state is derived server-side (authoritative) and customerId is
    // included so the client session is complete immediately after login.
    const profileState = await customerProfileState(user);
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
      },
    });
    res.headers.set("x-session-expires-at", expiresAt.toISOString());
    return res;
  },
  { auth: false }
);
