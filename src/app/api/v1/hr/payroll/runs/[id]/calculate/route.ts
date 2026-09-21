// MOHD.HMS ENTERPRISE — Payroll calculation endpoint (spec §9/§11/§63).
// POST triggers the centralized server-side engine (draft/failed/review runs
// only); the frontend only ever displays stored results.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { calculateRun } from "@/lib/hms/payroll/engine";

const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

export const POST = withId(PERMISSIONS.payroll_manage, async (id, { user }) => {
  const run = await db.payrollRun.findUnique({ where: { id } });
  if (!run) throw Errors.notFound("Payroll run not found.");

  const result = await calculateRun(id, user.id);

  await audit({
    actorId: user.id, actorEmail: user.email, action: "PAYROLL_CALCULATED",
    resourceType: "PAYROLL_RUN", resourceId: id,
    metadata: {
      code: run.code,
      employees: result.employeeCount,
      grossCents: result.grossCents,
      deductionsCents: result.deductionsCents,
      netCents: result.netCents,
      employerCostCents: result.employerCostCents,
      exceptions: result.exceptionCount,
    },
  });
  await emit({
    type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "PayrollRun", resourceId: id,
    payload: { code: run.code, status: result.status }, actorType: "USER", actorId: user.id,
  });
  return ok(result);
});
