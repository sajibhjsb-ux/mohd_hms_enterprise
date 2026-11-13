import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { verifyPassword } from "@/lib/hms/auth";
import { decryptSecret } from "@/lib/hms/mfa/crypto";
import { consumeRecoveryCode } from "@/lib/hms/mfa/recovery";
import { verifyTotp } from "@/lib/hms/mfa/totp";

const RECENT_RECOVERY_MS = 15 * 60 * 1000;

export async function requireMfaStepUp(
  user: { id: string; passwordHash: string },
  body: { password?: string; code?: string; recoveryCode?: string },
  ip?: string
): Promise<void> {
  const invalid = () => Errors.badRequest("Invalid verification code.");
  const hasPassword = user.passwordHash.startsWith("scrypt$");
  if (hasPassword && (!body.password || !(await verifyPassword(body.password, user.passwordHash)))) {
    throw invalid();
  }

  const hasCode = !!body.code;
  const hasRecovery = !!body.recoveryCode;
  if (hasCode && hasRecovery) throw invalid();

  const mfa = await db.userMfa.findUnique({ where: { userId: user.id } });
  if (!mfa?.mfaEnabled) throw invalid();

  if (!hasCode && !hasRecovery) {
    if (mfa.lastRecoveryAt && Date.now() - mfa.lastRecoveryAt.getTime() <= RECENT_RECOVERY_MS) return;
    throw invalid();
  }

  if (hasCode) {
    if (!mfa.encryptedTotpSecret) throw invalid();
    const result = await verifyTotp(decryptSecret(mfa.encryptedTotpSecret, user.id), body.code!, mfa.lastTotpStep);
    if (!result.valid) throw invalid();
    await db.userMfa.update({
      where: { userId: user.id },
      data: { lastTotpStep: result.timeStep ?? Math.floor(Date.now() / 1000), lastVerifiedAt: new Date() },
    });
    return;
  }

  if (!(await consumeRecoveryCode(user.id, body.recoveryCode!, ip))) throw invalid();
}
