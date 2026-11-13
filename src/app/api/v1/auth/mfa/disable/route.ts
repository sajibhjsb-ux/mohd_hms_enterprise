import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { clientIp } from "@/lib/hms/rate-limit";
import { audit, notify } from "@/lib/hms/services";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { getMfaPolicy } from "@/lib/hms/mfa/policy";
import { requireMfaStepUp } from "@/lib/hms/mfa/step-up";

const schema = z.object({
  password: z.string().optional(),
  code: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().optional(),
});

export const POST = handler(async ({ req, user }) => {
  assertMfaOrigin(req);
  const mfa = await db.userMfa.findUnique({ where: { userId: user.id } });
  if (!mfa?.mfaEnabled) throw Errors.badRequest("MFA is not enabled.");

  const policy = await getMfaPolicy(user.role);
  if (policy.policyMode === "MANDATORY") throw Errors.forbidden("MFA is required for your role and cannot be disabled.");

  const account = await db.user.findUnique({ where: { id: user.id }, select: { id: true, passwordHash: true } });
  if (!account) throw Errors.unauthorized();
  const ip = clientIp(req);
  await requireMfaStepUp(account, await parseBody(req, schema), ip);

  await db.$transaction(async (tx) => {
    await tx.userMfa.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.mfaChallenge.deleteMany({ where: { userId: user.id } });
  });

  await audit({ actorId: user.id, actorEmail: user.email, action: "MFA_DISABLED", resourceType: "AUTH", ip });
  await notify({
    userId: user.id,
    title: "Two-factor authentication disabled",
    message: "Two-factor authentication was turned off for your account. If this was not you, change your password immediately.",
    type: "WARNING",
    channels: ["IN_APP", "EMAIL"],
  });

  return ok({ disabled: true });
});
