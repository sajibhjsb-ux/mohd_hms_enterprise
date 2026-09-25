// MOHD.HMS ENTERPRISE — Authentication: password hashing + DB-backed sessions
// Passwords are hashed with scrypt (N=16384) + per-user random salt.
// Sessions are opaque random tokens stored in PostgreSQL-equivalent DB (source of truth),
// delivered via HttpOnly, SameSite=Lax cookie. Sliding renewal happens silently.
//
// SINGLE ACTIVE DEVICE (one account = one active session): a successful login
// on any device marks every other live session of the account revoked
// (Session.revokedAt) inside the login transaction. A revoked session's
// cookie no longer authorizes ANY request — the next call answers
// 401 SESSION_REVOKED and the realtime layer disconnects the old device, so
// presence drops and the UI logs out. There is NO inactivity auto-logout:
// a session stays valid until its absolute expiry, explicit logout, password
// change/reset, admin action, or replacement by another device's login.

import "server-only";
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { Permission } from "./constants";
import { can } from "./rbac";
import { emit } from "./workflows/bus";
import { EVENT_TYPES } from "./workflows/types";

const scrypt = promisify(_scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

export const SESSION_COOKIE = "hms_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
export const SESSION_REMEMBER_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days ("Remember me")
export const SESSION_RENEW_THRESHOLD_MS = SESSION_TTL_MS / 2;

/** Why getSessionUser() rejected the last request (consumed by handler() to
 *  emit the precise 401 code — SESSION_REVOKED for replaced sessions). */
type SessionRejectionReason = "EXPIRED" | "REVOKED" | "DISABLED" | null;
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
 * (= per device/browser), never per user, so devices stay independent. It
 * only extends the session's lifetime — it never bypasses the single-active-
 * device revocation (a revoked grant's cookie answers 401 SESSION_REVOKED).
 */
export async function createSession(
  userId: string, ip?: string, userAgent?: string,
  ttlMs: number = SESSION_TTL_MS, remember: boolean = false,
  tx?: Prisma.TransactionClient,
) {
  const client = tx ?? db;
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await client.session.create({
    data: { token, userId, expiresAt, ip: ip ?? null, userAgent: userAgent ?? null, remember },
  });
  return { token, expiresAt };
}

/**
 * SINGLE ACTIVE DEVICE (one account = one active session, spec §6/§21/§22):
 * the ONE canonical session-creation path for EVERY login surface. Inside a
 * single transaction it revokes every other live session of the account
 * (keeping the rows as audit records — their cookies stop authorizing anything
 * immediately → 401 SESSION_REVOKED), creates the new active session, and
 * emits SESSION_REVOKED on the same transaction so the superseded devices log
 * out instantly over the EXISTING realtime channel (§8) and the realtime
 * service's session sweep drops them from presence (§25).
 *
 * Concurrency: on PostgreSQL a per-user advisory xact lock serializes
 * concurrent logins, so no interleaving can produce two ACTIVE sessions
 * (§22/§23 — the database-level serialization that fits this Prisma schema);
 * on SQLite the single-writer database serializes transactions natively.
 *
 * Password login, customer email-OTP verification and the Google OAuth
 * callback all create their session through this helper — never through
 * createSession() directly — so one account can never hold two live sessions.
 */
export async function createSupersedingSession(
  userId: string, ip?: string, userAgent?: string,
  ttlMs: number = SESSION_TTL_MS, remember: boolean = false,
): Promise<{ token: string; expiresAt: Date; replacedCount: number }> {
  const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");
  return db.$transaction(async (tx) => {
    if (isPostgres) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
    const previous = await tx.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (previous.length > 0) {
      await tx.session.updateMany({
        where: { id: { in: previous.map((p) => p.id) } },
        data: { revokedAt: new Date(), revokedReason: "SUPERSEDED_BY_NEW_LOGIN" },
      });
      // §8: realtime revocation — emitted inside the transaction so the event
      // commits with the login itself. Safe metadata only (count/reason —
      // never tokens, session ids or network details).
      await emit({
        type: EVENT_TYPES.SESSION_REVOKED,
        resourceType: "SESSION",
        resourceId: userId,
        payload: { userId, reason: "SUPERSEDED_BY_NEW_LOGIN", revokedCount: previous.length },
        actorId: userId,
        tx,
      });
    }
    const created = await createSession(userId, ip, userAgent, ttlMs, remember, tx);
    return { ...created, replacedCount: previous.length };
  });
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
 * SINGLE ACTIVE DEVICE enforcement (server-authoritative): a session that was
 * revoked by a newer login on another device (Session.revokedAt) no longer
 * authorizes ANY request — every call answers 401 SESSION_REVOKED until the
 * client logs out. There is deliberately NO inactivity enforcement: an idle
 * session stays valid exactly as long as an active one (spec: inactivity ≠
 * session expiration).
 *
 * Silent sliding renewal of the ABSOLUTE expiry still applies, preserving the
 * session's own TTL class (7-day standard, 30-day remember-grant).
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({ where: { token }, include: { user: true } });
  if (!session) return null;

  // 1. Absolute expiry (7-day standard / 30-day remember cap — the sliding
  //    renewal below is the only thing that can extend it).
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    lastSessionRejection = "EXPIRED";
    return null;
  }

  // 2. Revoked by a newer login on another device (single active device).
  //    The row is kept as an audit record; the credential is dead.
  if (session.revokedAt) {
    lastSessionRejection = "REVOKED";
    return null;
  }

  if (session.user.status !== "ACTIVE") {
    lastSessionRejection = "DISABLED";
    return null;
  }

  // Silent sliding renewal (background, no reload — safe inside request scope),
  // preserving the session's TTL class.
  const remaining = session.expiresAt.getTime() - Date.now();
  if (remaining < SESSION_RENEW_THRESHOLD_MS) {
    const newExpiry = new Date(Date.now() + (session.remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS));
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

/** Password policy: min 8 chars, letter + number. */
export function validatePasswordStrength(pw: string): string | null {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters long.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and numbers.";
  return null;
}
