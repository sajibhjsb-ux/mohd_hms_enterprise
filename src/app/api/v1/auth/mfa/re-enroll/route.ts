import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { clientIp } from "@/lib/hms/rate-limit";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { startEnrollment } from "@/lib/hms/mfa/enrollment";
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
  await requireMfaStepUp(account, await parseBody(req, schema), clientIp(req));

  return ok(await startEnrollment(user, { replace: true }));
});
