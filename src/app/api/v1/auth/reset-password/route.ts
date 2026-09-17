import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { hashPassword, validatePasswordStrength } from "@/lib/hms/auth";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";

const schema = z.object({
  token: z.string().min(10),
  password: z.string().min(1),
});

export const POST = handler(
  async ({ req }) => {
    const rl = rateLimit(`pwreset-use:${clientIp(req)}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany();
    const { token, password } = await parseBody(req, schema);

    const strengthError = validatePasswordStrength(password);
    if (strengthError) throw Errors.badRequest(strengthError);

    const reset = await db.passwordResetToken.findUnique({ where: { token } });
    if (!reset || reset.usedAt || reset.expiresAt.getTime() < Date.now()) {
      throw Errors.badRequest("This reset link is invalid or has expired. Request a new one.");
    }
    const passwordHash = await hashPassword(password);
    await db.$transaction([
      db.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
      db.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      db.session.deleteMany({ where: { userId: reset.userId } }),
      db.setting.deleteMany({ where: { key: `dev_pwreset_${reset.userId}` } }),
    ]);
    await audit({ actorId: reset.userId, action: "PASSWORD_RESET", resourceType: "AUTH", resourceId: reset.userId });
    return ok({ message: "Password updated. You can now sign in." });
  },
  { auth: false }
);
