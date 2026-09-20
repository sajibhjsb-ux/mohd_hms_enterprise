// MOHD.HMS ENTERPRISE — Salary component update/deactivate (spec §6).
// System components (BASIC/OVERTIME/UNPAID_LEAVE engine hooks) cannot be
// deleted; used components are deactivated instead of removed.

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
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  taxable: z.boolean().optional(),
  active: z.boolean().optional(),
});

export const PATCH = withId(PERMISSIONS.payroll_manage, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const component = await db.salaryComponent.findUnique({ where: { id } });
  if (!component) throw Errors.notFound("Salary component not found.");
  if (body.name && body.name !== component.name) {
    const dup = await db.salaryComponent.findUnique({ where: { name: body.name } });
    if (dup) throw Errors.conflict(`Component "${body.name}" already exists.`);
  }
  const updated = await db.salaryComponent.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description ?? "" } : {}),
      ...(body.taxable !== undefined ? { taxable: body.taxable } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    },
  });
  await audit({
    actorId: user.id, actorEmail: user.email, action: "PAYROLL_COMPONENT_UPDATED",
    resourceType: "SALARY_COMPONENT", resourceId: id,
    metadata: { name: updated.name, changes: body },
  });
  return ok(updated);
});

export const DELETE = withId(PERMISSIONS.payroll_manage, async (id, { user }) => {
  const component = await db.salaryComponent.findUnique({
    where: { id },
    include: { _count: { select: { structures: true } } },
  });
  if (!component) throw Errors.notFound("Salary component not found.");
  if (component.system) throw Errors.badRequest("Engine-managed components cannot be deleted.");
  if (component._count.structures > 0) {
    // In use — soft-deactivate (history must keep resolving its name).
    const updated = await db.salaryComponent.update({ where: { id }, data: { active: false } });
    await audit({
      actorId: user.id, actorEmail: user.email, action: "PAYROLL_COMPONENT_DEACTIVATED",
      resourceType: "SALARY_COMPONENT", resourceId: id, metadata: { name: component.name },
    });
    return ok(updated);
  }
  await db.salaryComponent.delete({ where: { id } });
  await audit({
    actorId: user.id, actorEmail: user.email, action: "PAYROLL_COMPONENT_DELETED",
    resourceType: "SALARY_COMPONENT", resourceId: id, metadata: { name: component.name },
  });
  return ok({ deleted: true });
});
