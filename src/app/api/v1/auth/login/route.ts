import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { verifyPassword, createSession, setSessionCookie, SESSION_TTL_MS } from "@/lib/hms/auth";
import { can } from "@/lib/hms/rbac";
import { customerProfileState } from "@/lib/hms/customer-profile";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";
import type { Permission } from "@/lib/hms/constants";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

export const POST = handler(
  async ({ req }) => {
    const ip = clientIp(req);
    const { email, password } = await parseBody(req, loginSchema);

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

    const { token, expiresAt } = await createSession(user.id, ip, req.headers.get("user-agent") ?? undefined);
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
