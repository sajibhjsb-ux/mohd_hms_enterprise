import { NextResponse } from "next/server";
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
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { can } from "@/lib/hms/rbac";
import { customerProfileState } from "@/lib/hms/customer-profile";
import { isAvatarRef } from "@/lib/hms/profile-photo";
import { termsStatusFor } from "@/lib/hms/legal/legal";
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

    // SINGLE ACTIVE DEVICE (one account = one active session, §6/§21/§22):
    // the new login atomically revokes every other live session of this
    // account and creates its own — there is never more than one active
    // session per user. On PostgreSQL a per-user advisory lock serializes
    // concurrent logins (no interleaving can produce two active sessions);
    // on SQLite the single-writer database serializes transactions natively.
    // The superseded rows are kept with revokedAt/revokedReason as an audit
    // record — their cookies stop authorizing anything immediately
    // (getSessionUser → 401 SESSION_REVOKED, §9/§34).
    const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");
    const { token, expiresAt, replacedCount } = await db.$transaction(async (tx) => {
      if (isPostgres) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
      const previous = await tx.session.findMany({
        where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (previous.length > 0) {
        await tx.session.updateMany({
          where: { id: { in: previous.map((p) => p.id) } },
          data: { revokedAt: new Date(), revokedReason: "SUPERSEDED_BY_NEW_LOGIN" },
        });
      }
      const created = await createSession(
        user.id,
        ip,
        req.headers.get("user-agent") ?? undefined,
        remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS,
        remember,
        tx,
      );
      // §8: realtime revocation — the superseded devices receive
      // SESSION_REVOKED over the EXISTING socket and log out immediately
      // (their sockets are also re-verified by the realtime service's
      // session sweep, which then drops them from presence). Emitted inside
      // the transaction so the event commits with the login itself.
      if (previous.length > 0) {
        await emit({
          type: EVENT_TYPES.SESSION_REVOKED,
          resourceType: "SESSION",
          resourceId: user.id,
          payload: { userId: user.id, reason: "SUPERSEDED_BY_NEW_LOGIN", revokedCount: previous.length },
          actorId: user.id,
          tx,
        });
      }
      return { ...created, replacedCount: previous.length };
    });
    await setSessionCookie(token, expiresAt);
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit({ actorId: user.id, actorEmail: user.email, action: "LOGIN", resourceType: "AUTH", ip, metadata: { replacedSessions: replacedCount } });
    if (replacedCount > 0) {
      // §27: session replacement is audited with safe metadata only (count —
      // never tokens, session ids or network details).
      await audit({
        actorId: user.id, actorEmail: user.email,
        action: "SESSION_REPLACED", resourceType: "SESSION",
        metadata: { revokedCount: replacedCount, reason: "SUPERSEDED_BY_NEW_LOGIN", via: "login" },
        ip,
      });
    }
    if (remember) {
      // USER-CONTROLLED AUTO LOGIN: the login checkbox explicitly opted this
      // device into a persistent-login grant (30-day cap, revocable, audited).
      await audit({ actorId: user.id, actorEmail: user.email, action: "PERSISTENT_SESSION_CREATED", resourceType: "SESSION", metadata: { via: "login" }, ip });
    }

    // Profile state is derived server-side (authoritative) and customerId is
    // included so the client session is complete immediately after login.
    // Terms acceptance state ships too, so the consent gate renders without a
    // waiting for the first session refresh. avatarUrl comes from the DB (the
    // persistent source) — only valid storage keys are ever delivered.
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
        avatarUrl: isAvatarRef(user.avatarUrl) ? user.avatarUrl : null,
      },
    });
    res.headers.set("x-session-expires-at", expiresAt.toISOString());
    return res;
  },
  { auth: false }
);
