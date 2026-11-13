import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, Role } from "@/lib/hms/constants";
import { clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";
import { assertMfaOrigin } from "@/lib/hms/mfa/http";
import { ensureMfaPolicies, getMfaPolicyMap, canManageRole } from "@/lib/hms/mfa/policy";
import { resetUserMfa } from "@/lib/hms/mfa/enrollment";

const policySchema = z.object({
  policies: z.array(
    z.object({
      role: z.enum(["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "CUSTOMER", "FINANCE", "HR"] as const),
      policyMode: z.enum(["MANDATORY", "OPTIONAL", "DISABLED"]),
      gracePeriodDays: z.number().int().min(0).max(365),
    })
  ),
});

export const GET = handler(
  async () => {
    await ensureMfaPolicies();
    const map = await getMfaPolicyMap();
    const now = new Date();
    const users = await db.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, role: true } });
    const mfas = await db.userMfa.findMany();
    const byUser = new Map(mfas.map((m) => [m.userId, m]));
    let enrolled = 0, pending = 0, grace = 0, required = 0, notEnrolled = 0;
    for (const u of users) {
      const policy = map[u.role];
      if (policy.policyMode !== "MANDATORY") {
        notEnrolled++;
        continue;
      }
      const mfa = byUser.get(u.id);
      if (mfa?.mfaEnabled) enrolled++;
      else if (mfa?.pendingEnrollmentExpiresAt && mfa.pendingEnrollmentExpiresAt > now) pending++;
      else if (mfa?.graceUntil && mfa.graceUntil > now) grace++;
      else required++;
    }
    const total = enrolled + pending + grace + required;
    return ok({
      policies: Object.values(map),
      compliance: { total, enrolled, required, pending, grace, notEnrolled, percent: total === 0 ? 100 : Math.round((enrolled / total) * 100) },
    });
  },
  { permission: PERMISSIONS.mfa_policy_read }
);

export const PUT = handler(
  async ({ req, user }) => {
    assertMfaOrigin(req);
    const { policies } = await parseBody(req, policySchema);
    const actor = user;
    await ensureMfaPolicies();
    const now = new Date();
    for (const entry of policies) {
      if (!canManageRole(actor.role, entry.role)) throw Errors.forbidden(`You cannot manage MFA policy for ${entry.role}.`);
      await db.mfaPolicy.upsert({
        where: { role: entry.role },
        update: { policyMode: entry.policyMode, gracePeriodDays: entry.gracePeriodDays },
        create: { role: entry.role, policyMode: entry.policyMode, gracePeriodDays: entry.gracePeriodDays },
      });
      if (entry.policyMode === "MANDATORY") {
        const graceUntil = new Date(now.getTime() + entry.gracePeriodDays * 24 * 60 * 60 * 1000);
        const roleUsers = await db.user.findMany({ where: { role: entry.role, status: "ACTIVE" }, select: { id: true } });
        const mfas = await db.userMfa.findMany({ where: { userId: { in: roleUsers.map((u) => u.id) } } });
        const hasMfa = new Set(mfas.map((m) => m.userId));
        for (const u of roleUsers) {
          const mfa = mfas.find((m) => m.userId === u.id);
          if (!mfa?.mfaEnabled && (!mfa || !mfa.graceUntil || mfa.graceUntil <= now)) {
            await db.userMfa.upsert({
              where: { userId: u.id },
              update: { graceUntil },
              create: { userId: u.id, graceUntil },
            });
          }
        }
      }
      await audit({ actorId: actor.id, actorEmail: actor.email, action: "MFA_POLICY_UPDATED", resourceType: "AUTH", resourceId: entry.role, metadata: { role: entry.role, policyMode: entry.policyMode, gracePeriodDays: entry.gracePeriodDays } });
    }
    return ok(await getMfaPolicyMap());
  },
  { permission: PERMISSIONS.mfa_policy_manage }
);
