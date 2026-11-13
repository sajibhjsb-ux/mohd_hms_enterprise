import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { clientIp } from "@/lib/hms/rate-limit";
import { audit, notify } from "@/lib/hms/services";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { generateRecoveryCodes, replaceRecoveryCodes } from "@/lib/hms/mfa/recovery";
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

  const account = await db.user.findUnique({ where: { id: user.id }, select: { id: true, passwordHash: true } });
  if (!account) throw Errors.unauthorized();
  const ip = clientIp(req);
  await requireMfaStepUp(account, await parseBody(req, schema), ip);

  const codes = generateRecoveryCodes();
  await db.$transaction(async (tx) => {
    await replaceRecoveryCodes(user.id, codes, tx);
    await tx.userMfa.update({ where: { userId: user.id }, data: { recoveryCodesGeneratedAt: new Date() } });
  });

  await audit({ actorId: user.id, actorEmail: user.email, action: "MFA_RECOVERY_REGENERATED", resourceType: "AUTH", ip });
  await notify({
    userId: user.id,
    title: "Recovery codes regenerated",
    message: "New two-factor recovery codes were generated. The previous codes no longer work.",
    type: "SUCCESS",
    channels: ["IN_APP", "EMAIL"],
  });

  return ok({ recoveryCodes: codes });
});
