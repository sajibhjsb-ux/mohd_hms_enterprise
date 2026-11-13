import QRCode from "qrcode";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { audit, notify } from "@/lib/hms/services";
import { enrollTtl } from "@/lib/hms/mfa/gate";
import { decryptSecret, encryptSecret } from "@/lib/hms/mfa/crypto";
import { createTotpSecret, totpUri, verifyTotp } from "@/lib/hms/mfa/totp";
import { generateRecoveryCodes, replaceRecoveryCodes } from "@/lib/hms/mfa/recovery";

export async function startEnrollment(
  user: { id: string; email: string },
  opts?: { replace?: boolean }
): Promise<{ secret: string; otpauthUri: string; qrDataUrl: string; expiresAt: Date }> {
  const secret = createTotpSecret();
  const otpauthUri = totpUri(secret, user.email);
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 240, margin: 1, errorCorrectionLevel: "M" });
  const expiresAt = new Date(Date.now() + enrollTtl());

  await db.userMfa.upsert({
    where: { userId: user.id },
    update: { pendingEncryptedSecret: encryptSecret(secret, user.id), pendingEnrollmentExpiresAt: expiresAt },
    create: {
      userId: user.id,
      pendingEncryptedSecret: encryptSecret(secret, user.id),
      pendingEnrollmentExpiresAt: expiresAt,
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "MFA_ENROLL_STARTED",
    resourceType: "AUTH",
    metadata: opts?.replace ? { replace: true } : {},
  });
  await notify({
    userId: user.id,
    title: "MFA enrolment started",
    message: "Two-factor authentication enrolment was started for your account. If this was not you, change your password immediately.",
    type: "INFO",
    channels: ["IN_APP", "EMAIL"],
  });

  return { secret, otpauthUri, qrDataUrl, expiresAt };
}

export async function confirmEnrollment(
  userId: string,
  token: string,
  ip?: string
): Promise<{ recoveryCodes: string[]; timeStep: number }> {
  const row = await db.userMfa.findUnique({ where: { userId }, include: { user: true } });
  if (!row?.pendingEncryptedSecret || !row.pendingEnrollmentExpiresAt || row.pendingEnrollmentExpiresAt <= new Date()) {
    throw Errors.badRequest("Invalid verification code.");
  }

  const secret = decryptSecret(row.pendingEncryptedSecret, userId);
  const result = await verifyTotp(secret, token, null);
  if (!result.valid) {
    await audit({ actorId: userId, actorEmail: row.user.email, action: "MFA_VERIFY_FAILED", resourceType: "AUTH", ip, metadata: { phase: "ENROLL" } });
    throw Errors.badRequest("Invalid verification code.");
  }

  const codes = generateRecoveryCodes();
  const timeStep = result.timeStep ?? Math.floor(Date.now() / 1000);
  const reenrolled = !!row.enrolledAt;

  await db.$transaction(async (tx) => {
    await tx.userMfa.update({
      where: { userId },
      data: {
        mfaEnabled: true,
        encryptedTotpSecret: row.pendingEncryptedSecret,
        pendingEncryptedSecret: null,
        pendingEnrollmentExpiresAt: null,
        enrolledAt: row.enrolledAt ?? new Date(),
        lastVerifiedAt: new Date(),
        lastTotpStep: timeStep,
        recoveryCodesGeneratedAt: new Date(),
      },
    });
    await replaceRecoveryCodes(userId, codes, tx);
  });

  await audit({
    actorId: userId,
    actorEmail: row.user.email,
    action: reenrolled ? "MFA_REENROLLED" : "MFA_ENROLLED",
    resourceType: "AUTH",
    ip,
  });
  await notify({
    userId,
    title: reenrolled ? "Authenticator replaced" : "Two-factor authentication enabled",
    message: reenrolled
      ? "Your authenticator app was replaced. The previous recovery codes no longer work."
      : "Two-factor authentication is now enabled for your account. Store your recovery codes safely.",
    type: "SUCCESS",
    channels: ["IN_APP", "EMAIL"],
  });

  return { recoveryCodes: codes, timeStep };
}

export async function resetUserMfa(
  userId: string,
  opts: { actorId?: string; actorEmail?: string; reason: string; ip?: string }
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) throw Errors.notFound("User not found.");

  await db.$transaction(async (tx) => {
    await tx.userMfa.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaChallenge.deleteMany({ where: { userId } });
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "MFA_RESET_BY_ADMIN" },
    });
  });

  await audit({
    actorId: opts.actorId,
    actorEmail: opts.actorEmail,
    action: "MFA_RESET_BY_ADMIN",
    resourceType: "AUTH",
    resourceId: userId,
    ip: opts.ip,
    metadata: { reason: opts.reason },
  });
  await notify({
    userId,
    title: "Two-factor authentication reset",
    message: "An administrator reset two-factor authentication for your account. You will be asked to set it up again at your next sign-in.",
    type: "WARNING",
    channels: ["IN_APP", "EMAIL"],
  });
}
