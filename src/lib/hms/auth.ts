// MOHD.HMS ENTERPRISE — Authentication: password hashing + DB-backed sessions
// Passwords are hashed with scrypt (N=16384) + per-user random salt.
// Sessions are opaque random tokens stored in PostgreSQL-equivalent DB (source of truth),
// delivered via HttpOnly, SameSite=Lax cookie. Sliding renewal happens silently.
//
// IDLE TIMEOUT (inactivity auto-logout): every session carries lastActivityAt,
// advanced ONLY by genuine user-activity reports (POST /api/v1/auth/activity,
// driven by real UI events). Background traffic — API polling, the session
// heartbeat, WebSocket heartbeats, token refresh — NEVER advances it. The
// server enforces the timeout on every authenticated request: when the idle
// threshold has passed, the session is invalidated and the caller receives
// 401 SESSION_EXPIRED. The frontend timer is UX only; the server is authoritative.

import "server-only";
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import type { Permission } from "./constants";
import { can } from "./rbac";

const scrypt = promisify(_scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

export const SESSION_COOKIE = "hms_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
export const SESSION_REMEMBER_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days ("Remember me")
export const SESSION_RENEW_THRESHOLD_MS = SESSION_TTL_MS / 2;

/** Idle (inactivity) auto-logout timeout. Production value: 300 seconds (5
 *  minutes). Centralized here — automated tests run the server with
 *  SESSION_IDLE_TIMEOUT_SECONDS=5 instead of touching production behaviour. */
export const SESSION_IDLE_TIMEOUT_SECONDS = (() => {
  const raw = Number(process.env.SESSION_IDLE_TIMEOUT_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300;
})();
export const SESSION_IDLE_TIMEOUT_MS = SESSION_IDLE_TIMEOUT_SECONDS * 1000;

/** Why getSessionUser() rejected the last request (consumed by handler() to
 *  emit the precise 401 code — SESSION_EXPIRED for idle timeout). */
type SessionRejectionReason = "IDLE_TIMEOUT" | "EXPIRED" | "REVOKED" | "DISABLED" | null;
let lastSessionRejection: SessionRejectionReason = null;

/** Read-and-clear the rejection reason of the most recent getSessionUser(). */
export function consumeSessionRejectionReason(): SessionRejectionReason {
  const reason = lastSessionRejection;
  lastSessionRejection = null;
  return reason;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const derived = await scrypt(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function generateToken(): string {
  return randomBytes(48).toString("base64url");
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  customerId: string | null;
  permissions: Permission[];
  sessionExpiresAt: Date;
};

/**
 * Create a DB-backed session. `ttlMs` defaults to the standard 7-day TTL;
 * the login flow passes SESSION_REMEMBER_TTL_MS when "Remember me" is set
 * (sliding renewal continues to apply to both variants).
 *
 * `remember` is the user-controlled Auto Login grant ("Keep me signed in on
 * this device") — DEFAULT false. Only an explicit user choice (login checkbox
 * or the Profile → Security toggle) ever sets it; it is stored per SESSION
 * (= per device/browser), never per user, so devices stay independent.
 */
export async function createSession(userId: string, ip?: string, userAgent?: string, ttlMs: number = SESSION_TTL_MS, remember: boolean = false) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  const lastActivityAt = new Date(); // a fresh sign-in is, by definition, active
  await db.session.create({
    data: { token, userId, expiresAt, ip: ip ?? null, userAgent: userAgent ?? null, lastActivityAt, remember },
  });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 0, path: "/" });
}

/**
 * Resolve the current session user.
 *
 * INACTIVITY ENFORCEMENT (server-authoritative): when the session has been
 * idle — no genuine user-activity report — for SESSION_IDLE_TIMEOUT_MS, the
 * session is deleted here and the rejection reason is recorded so handler()
 * answers 401 SESSION_EXPIRED. Background requests still run through this
 * funnel and get rejected exactly the same way: they can never keep an idle
 * session alive.
 *
 * Silent sliding renewal of the ABSOLUTE expiry (expiresAt, 7-day window)
 * still happens as before — it never touches lastActivityAt.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({ where: { token }, include: { user: true } });
  if (!session) return null;

  // 1. Absolute expiry (the 30-day cap for remember-grants too — the sliding
  //    renewal below is the only thing that can extend it, and it only runs
  //    for live sessions).
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    lastSessionRejection = "EXPIRED";
    return null;
  }

  // 1b. Already idle-revoked remember-grant: the live credential was revoked
  //     by a previous idle expiry. It stays LOGGED OUT for every normal
  //     request — restoration is only possible via the dedicated restore
  //     endpoint, never by carrying on with the stale cookie.
  if (session.idleRevokedAt) {
    lastSessionRejection = "IDLE_TIMEOUT";
    return null;
  }

  // 2. Idle timeout — the inactivity auto-logout. The user record is loaded
  //    with the session, so the audit has full actor context.
  //    USER-CONTROLLED AUTO LOGIN: a remember-grant is not deleted here — the
  //    LIVE credential is revoked (idleRevokedAt) so the user is genuinely
  //    logged out (this and every other request fail 401 SESSION_EXPIRED),
  //    while the grant itself survives for a possible restoration on a fresh
  //    app open. Non-remember sessions keep the historical delete behavior.
  const idleMs = Date.now() - session.lastActivityAt.getTime();
  if (idleMs >= SESSION_IDLE_TIMEOUT_MS) {
    if (session.remember) {
      await db.session.update({ where: { id: session.id }, data: { idleRevokedAt: new Date() } }).catch(() => undefined);
    } else {
      await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    }
    lastSessionRejection = "IDLE_TIMEOUT";
    try {
      const { audit } = await import("@/lib/hms/services");
      await audit({
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "SESSION_EXPIRED_IDLE_TIMEOUT",
        resourceType: "SESSION",
        resourceId: session.id,
        metadata: { idleSeconds: Math.floor(idleMs / 1000), thresholdSeconds: SESSION_IDLE_TIMEOUT_SECONDS, email: session.user.email },
      });
    } catch { /* audit must never block the rejection */ }
    return null;
  }
  if (session.user.status !== "ACTIVE") {
    lastSessionRejection = "DISABLED";
    return null;
  }

  // Silent sliding renewal (background, no reload — safe inside request scope)
  const remaining = session.expiresAt.getTime() - Date.now();
  if (remaining < SESSION_RENEW_THRESHOLD_MS) {
    const newExpiry = new Date(Date.now() + SESSION_TTL_MS);
    await db.session.update({ where: { id: session.id }, data: { expiresAt: newExpiry, lastSeenAt: new Date() } }).catch(() => undefined);
    try {
      jar.set(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        expires: newExpiry,
        path: "/",
      });
    } catch { /* cookie write not permitted in this context */ }
  } else {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    status: session.user.status,
    customerId: session.user.customerId,
    permissions: can(session.user.role as never),
    sessionExpiresAt: session.expiresAt,
  };
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.session.deleteMany({ where: { token } }).catch(() => undefined);
  }
  await clearSessionCookie();
}

/** Mark a remember-grant as idle-revoked WITHOUT deleting it (used by the
 *  client-initiated inactivity logout, reason "idle"). Returns false for any
 *  session that is not a live remember-grant — the caller then falls back to
 *  the normal destructive logout. Manual logout NEVER calls this: explicit
 *  sign-out always destroys the grant (§auto-login: logout wins). */
export async function markSessionIdleRevoked(token: string): Promise<boolean> {
  const s = await db.session.findUnique({ where: { token } }).catch(() => null);
  if (!s || !s.remember || s.idleRevokedAt) return false;
  await db.session.update({ where: { id: s.id }, data: { idleRevokedAt: new Date() } }).catch(() => undefined);
  return true;
}

export type RestoreResult =
  | { restored: true; user: SessionUser; expiresAt: Date }
  | { restored: false; reason: string | null; rejected: boolean };

/**
 * USER-CONTROLLED AUTO LOGIN — secure persistent-session restoration.
 *
 * Called ONLY by POST /api/v1/auth/auto-login/restore on a genuinely fresh
 * app open (the client skips it entirely when the current tab was itself
 * logged out — sessionStorage notice — so auto login can never defeat the
 * 5-minute inactivity timeout in the same sitting).
 *
 * Server-authoritative validation chain: the cookie must hold the token of a
 * remember-grant that (a) still exists — explicit logout, password change /
 * reset, admin reset and user disable all DELETE the row, (b) is within its
 * absolute expiry, (c) is actually idle-revoked (a live session never needs
 * restoration), and (d) belongs to an ACTIVE user. The authoritative role and
 * permissions are re-resolved from the User row — never replayed from stale
 * state. On success the token is ROTATED (the old credential sat in a logged-
 * out browser) and a fresh HttpOnly cookie is issued.
 */
export async function restorePersistentSession(): Promise<RestoreResult> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return { restored: false, reason: null, rejected: false };
  const session = await db.session.findUnique({ where: { token }, include: { user: true } }).catch(() => null);
  if (!session) return { restored: false, reason: "session-gone", rejected: true };
  if (!session.remember) return { restored: false, reason: "not-a-grant", rejected: true };
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return { restored: false, reason: "expired", rejected: true };
  }
  if (!session.idleRevokedAt) return { restored: false, reason: "not-idle-revoked", rejected: true };
  if (session.user.status !== "ACTIVE") return { restored: false, reason: "user-not-active", rejected: true };

  const newToken = generateToken();
  await db.session.update({
    where: { id: session.id },
    data: { token: newToken, idleRevokedAt: null, lastActivityAt: new Date(), lastSeenAt: new Date() },
  }).catch(() => undefined);
  await setSessionCookie(newToken, session.expiresAt);
  return {
    restored: true,
    expiresAt: session.expiresAt,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
      status: session.user.status,
      customerId: session.user.customerId,
      permissions: can(session.user.role as never),
      sessionExpiresAt: session.expiresAt,
    },
  };
}

/** Password policy: min 8 chars, letter + number. */
export function validatePasswordStrength(pw: string): string | null {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters long.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and numbers.";
  return null;
}
