import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { getMfaPolicy } from "@/lib/hms/mfa/policy";
import { countUnusedRecoveryCodes } from "@/lib/hms/mfa/recovery";

export const GET = handler(async ({ user }) => {
  const [mfa, policy, remainingRecoveryCodes] = await Promise.all([
    db.userMfa.findUnique({ where: { userId: user.id } }),
    getMfaPolicy(user.role),
    countUnusedRecoveryCodes(user.id),
  ]);
  const enabled = !!mfa?.mfaEnabled;
  return ok({
    enabled,
    method: enabled ? "TOTP" : null,
    enrolledAt: mfa?.enrolledAt?.toISOString() ?? null,
    lastVerifiedAt: mfa?.lastVerifiedAt?.toISOString() ?? null,
    remainingRecoveryCodes,
    policyMode: policy.policyMode,
    canDisable: enabled && policy.policyMode !== "MANDATORY",
    canReenroll: enabled,
  });
});
