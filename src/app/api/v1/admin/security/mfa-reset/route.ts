import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { clientIp, rateLimit } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { canManageRole } from "@/lib/hms/mfa/policy";
import { resetUserMfa } from "@/lib/hms/mfa/enrollment";

const schema = z.object({ userId: z.string().min(1), reason: z.string().min(5) });

export const POST = handler(
  async ({ req, user }) => {
    assertMfaOrigin(req);
    const ip = clientIp(req);
    const rl = rateLimit(`mfa-admin-reset:${user.id}`, 20, 60 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany(`Too many reset attempts. Try again in ${rl.retryAfterSec}s.`);

    const { userId, reason } = await parseBody(req, schema);
    const actor = user;

    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, status: true } });
    if (!target) throw Errors.notFound("User not found.");
    if (target.id === actor.id) throw Errors.badRequest("You cannot reset your own MFA.");
    if (!canManageRole(actor.role, target.role)) throw Errors.forbidden(`You cannot reset MFA for a ${target.role}.`);

    await resetUserMfa(target.id, { actorId: actor.id, actorEmail: actor.email, reason, ip });

    await audit({ actorId: actor.id, actorEmail: actor.email, action: "MFA_ADMIN_RESET", resourceType: "AUTH", resourceId: target.id, ip, metadata: { targetEmail: target.email, targetRole: target.role, reason } });

    return ok({ reset: true });
  },
  { permission: PERMISSIONS.mfa_policy_manage }
);
