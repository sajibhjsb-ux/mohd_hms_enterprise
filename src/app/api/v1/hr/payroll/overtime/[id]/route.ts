// MOHD.HMS ENTERPRISE — Overtime approval (spec §15, existing HR approval
// architecture). On approval the payable amount is computed server-side from
// the employee's basic salary for the overtime month and snapshotted.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { audit, notify } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { computeOvertimeAmount } from "@/lib/hms/payroll/engine";

const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

const patchSchema = z.object({ action: z.enum(["approve", "reject"]) });

export const PATCH = withId(PERMISSIONS.hr_manage, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const ot = await db.overtimeRequest.findUnique({
    where: { id },
    include: { employee: { select: { userId: true, firstName: true, lastName: true, employeeNo: true, salaryCents: true } } },
  });
  if (!ot) throw Errors.notFound("Overtime request not found.");
  if (ot.status !== "PENDING") throw Errors.invalidTransition(`Request already ${ot.status.toLowerCase()}.`);

  if (body.action === "reject") {
    const updated = await db.overtimeRequest.update({
      where: { id },
      data: { status: "REJECTED", approvedById: user.id, approvedAt: new Date() },
    });
    await audit({
      actorId: user.id, actorEmail: user.email, action: "OVERTIME_REJECTED",
      resourceType: "OVERTIME_REQUEST", resourceId: id,
      metadata: { employeeNo: ot.employee.employeeNo },
    });
    await emit({ type: EVENT_TYPES.HR_OVERTIME_UPDATED, resourceType: "OvertimeRequest", resourceId: id, payload: { status: "REJECTED" }, actorType: "USER", actorId: user.id });
    return ok(updated);
  }

  // Approve → compute the amount from the employee's basic salary (server-side
  // authority; structures take precedence over the legacy salary field).
  const basicStructure = await db.salaryStructure.findFirst({
    where: { employeeId: ot.employeeId, effectiveFrom: { lte: ot.date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: ot.date } }], component: { category: "BASIC" } },
    orderBy: { effectiveFrom: "desc" },
  });
  const monthlyBasicCents = basicStructure?.amountCents ?? ot.employee.salaryCents;
  const { amountCents, rateBasisCents } = computeOvertimeAmount(monthlyBasicCents, ot.date, ot.minutes, ot.multiplier);

  const updated = await db.overtimeRequest.update({
    where: { id },
    data: { status: "APPROVED", approvedById: user.id, approvedAt: new Date(), amountCents, rateBasisCents },
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "OVERTIME_APPROVED",
    resourceType: "OVERTIME_REQUEST", resourceId: id,
    metadata: { employeeNo: ot.employee.employeeNo, hours: ot.minutes / 60, multiplier: ot.multiplier, amountCents, rateBasisCents, monthlyBasicCents },
  });
  await emit({ type: EVENT_TYPES.HR_OVERTIME_UPDATED, resourceType: "OvertimeRequest", resourceId: id, payload: { status: "APPROVED", amountCents }, actorType: "USER", actorId: user.id });
  if (ot.employee.userId) {
    await notify({
      userId: ot.employee.userId,
      title: "Overtime approved",
      message: `Your overtime on ${ot.date.toISOString().slice(0, 10)} was approved and will be included in the payroll.`,
      type: "SUCCESS",
      resourceType: "OVERTIME_REQUEST", resourceId: id,
    });
  }
  return ok(updated);
});
