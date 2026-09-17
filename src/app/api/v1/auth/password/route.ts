import { cookies } from "next/headers";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { hashPassword, verifyPassword, validatePasswordStrength, SESSION_COOKIE } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";

const schema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });

/** Change own password. Invalidates all other sessions, keeps the current one. */
export const POST = handler(
  async ({ req, user }) => {
    const { currentPassword, newPassword } = await parseBody(req, schema);
    const dbUser = await db.user.findUnique({ where: { id: user.id } });
    if (!dbUser) throw Errors.notFound();
    const valid = await verifyPassword(currentPassword, dbUser.passwordHash);
    if (!valid) throw Errors.badRequest("Current password is incorrect.");
    const strengthError = validatePasswordStrength(newPassword);
    if (strengthError) throw Errors.badRequest(strengthError);

    const passwordHash = await hashPassword(newPassword);
    const jar = await cookies();
    const currentToken = jar.get(SESSION_COOKIE)?.value ?? "";
    await db.$transaction([
      db.user.update({ where: { id: user.id }, data: { passwordHash } }),
      db.session.deleteMany({ where: { userId: user.id, token: { not: currentToken } } }),
    ]);
    await audit({ actorId: user.id, actorEmail: user.email, action: "PASSWORD_CHANGED", resourceType: "AUTH", resourceId: user.id });
    return ok({ message: "Password changed." });
  }
);
