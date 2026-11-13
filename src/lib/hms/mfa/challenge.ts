import { createHash, randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const MFA_COOKIE = "hms_mfa";
export const MFA_MAX_ATTEMPTS = 5;

export type MfaPurpose = "LOGIN" | "ENROLL" | "REENROLL";

type Client = Prisma.TransactionClient;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createMfaChallenge(
  input: { userId: string; purpose: MfaPurpose; ttlMs: number; remember?: boolean; ip?: string; userAgent?: string },
  tx?: Client
): Promise<{ token: string; expiresAt: Date; challengeId: string }> {
  const c = tx ?? db;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.ttlMs);
  const challenge = await c.mfaChallenge.create({
    data: {
      userId: input.userId,
      tokenHash: hashToken(token),
      purpose: input.purpose,
      expiresAt,
      remember: input.remember ?? false,
      ip: input.ip,
      userAgent: input.userAgent,
    },
  });
  return { token, expiresAt, challengeId: challenge.id };
}

export async function readMfaChallenge(
  req: NextRequest,
  purpose: MfaPurpose | MfaPurpose[]
): Promise<{ challenge: Prisma.MfaChallengeGetPayload<{ include: { user: true } }>; user: Prisma.UserGetPayload<object> } | null> {
  const token = req.cookies.get(MFA_COOKIE)?.value;
  if (!token) return null;
  const challenge = await db.mfaChallenge.findFirst({
    where: {
      tokenHash: hashToken(token),
      purpose: Array.isArray(purpose) ? { in: purpose } : purpose,
      usedAt: null,
      expiresAt: { gt: new Date() },
      attempts: { lt: MFA_MAX_ATTEMPTS },
    },
    include: { user: true },
  });
  return challenge ? { challenge, user: challenge.user } : null;
}

export async function consumeMfaChallenge(challengeId: string, tx?: Client): Promise<boolean> {
  const c = tx ?? db;
  const result = await c.mfaChallenge.updateMany({
    where: { id: challengeId, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return result.count === 1;
}

export async function registerMfaFailure(challengeId: string, tx?: Client): Promise<number> {
  const c = tx ?? db;
  const updated = await c.mfaChallenge.update({ where: { id: challengeId }, data: { attempts: { increment: 1 } } });
  if (updated.attempts >= MFA_MAX_ATTEMPTS) {
    await c.mfaChallenge.updateMany({ where: { id: challengeId, usedAt: null }, data: { usedAt: new Date() } });
  }
  return Math.max(0, MFA_MAX_ATTEMPTS - updated.attempts);
}

export function setMfaCookie(res: NextResponse, token: string, expiresAt: Date): void {
  res.cookies.set(MFA_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

export function clearMfaCookie(res: NextResponse): void {
  res.cookies.set(MFA_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
}
