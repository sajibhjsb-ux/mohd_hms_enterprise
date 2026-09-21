// MOHD.HMS ENTERPRISE — End (revoke) a salary structure row (spec §7).
// History is never deleted; ending sets effectiveTo. A BASIC row being ended
// re-mirrors the latest remaining current BASIC (or 0) onto the employee.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
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

export const DELETE = withId(PERMISSIONS.payroll_manage, async (id, { user }) => {
  const structure = await db.salaryStructure.findUnique({
    where: { id },
    include: { component: { select: { name: true, category: true } } },
  });
  if (!structure) throw Errors.notFound("Salary structure entry not found.");
  if (structure.effectiveTo) throw Errors.badRequest("Entry already ended.");

  const effectiveTo = new Date(Date.now() - 86_400_000);
  await db.$transaction(async (tx) => {
    await tx.salaryStructure.update({ where: { id }, data: { effectiveTo } });
    if (structure.component.category === "BASIC") {
      const latest = await tx.salaryStructure.findFirst({
        where: { employeeId: structure.employeeId, effectiveTo: null, component: { category: "BASIC" } },
        orderBy: { effectiveFrom: "desc" },
      });
      await tx.employee.update({
        where: { id: structure.employeeId },
        data: { salaryCents: latest?.amountCents ?? 0 },
      });
    }
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "SALARY_STRUCTURE_ENDED",
    resourceType: "SALARY_STRUCTURE", resourceId: id,
    metadata: { component: structure.component.name, effectiveTo: effectiveTo.toISOString() },
  });
  return ok({ ended: true });
});
