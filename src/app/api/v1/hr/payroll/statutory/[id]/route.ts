// MOHD.HMS ENTERPRISE — Statutory rule update / deactivation (spec §18).
// Rate changes should be modelled as a NEW dated version row (POST /statutory)
// with the old row's effectiveTo set — legislation changes are versioned, not
// silently rewritten. PATCH here handles metadata, expiry and activation;
// DELETE soft-deactivates (history must remain reproducible, §46).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";

const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

const patchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  notes: z.string().trim().max(300).nullable().optional(),
  reference: z.string().trim().max(300).nullable().optional(),
  calcOrder: z.coerce.number().int().min(1).max(999).optional(),
  effectiveTo: z.string().nullable().optional(),
  active: z.boolean().optional(),
  threshold: z.union([z.coerce.number(), z.string()]).optional(),
});

export const PATCH = withId(PERMISSIONS.payroll_manage, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const rule = await db.statutoryRule.findUnique({ where: { id } });
  if (!rule) throw Errors.notFound("Statutory rule not found.");

  const data: Record<string, unknown> = {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.notes !== undefined ? { notes: body.notes ?? "" } : {}),
    ...(body.reference !== undefined ? { reference: body.reference ?? "" } : {}),
    ...(body.calcOrder !== undefined ? { calcOrder: body.calcOrder } : {}),
    ...(body.active !== undefined ? { active: body.active } : {}),
    ...(body.effectiveTo !== undefined
      ? { effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null }
      : {}),
    ...(body.threshold !== undefined ? { thresholdCents: Math.round(Number(body.threshold) * 100) } : {}),
  };

  const updated = await db.statutoryRule.update({ where: { id }, data });
  await audit({
    actorId: user.id, actorEmail: user.email, action: "STATUTORY_RULE_UPDATED",
    resourceType: "STATUTORY_RULE", resourceId: id,
    metadata: { name: rule.name, changes: body },
  });
  return ok(updated);
});

export const DELETE = withId(PERMISSIONS.payroll_manage, async (id, { user }) => {
  const rule = await db.statutoryRule.findUnique({ where: { id } });
  if (!rule) throw Errors.notFound("Statutory rule not found.");
  // Soft-deactivate — finalized payroll snapshots reference these rules (§46).
  const updated = await db.statutoryRule.update({ where: { id }, data: { active: false } });
  await audit({
    actorId: user.id, actorEmail: user.email, action: "STATUTORY_RULE_DEACTIVATED",
    resourceType: "STATUTORY_RULE", resourceId: id, metadata: { name: rule.name },
  });
  return ok(updated);
});
