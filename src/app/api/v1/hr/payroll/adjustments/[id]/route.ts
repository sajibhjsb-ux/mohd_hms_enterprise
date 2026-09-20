// MOHD.HMS ENTERPRISE — Payroll adjustment approval (spec §24).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

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

export const PATCH = withId(PERMISSIONS.payroll_approve, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const adjustment = await db.payrollAdjustment.findUnique({
    where: { id },
    include: { run: { select: { id: true, code: true, status: true } } },
  });
  if (!adjustment) throw Errors.notFound("Adjustment not found.");
  if (adjustment.status !== "PENDING") throw Errors.badRequest(`Adjustment already ${adjustment.status.toLowerCase()}.`);
  if (adjustment.createdById === user.id) {
    throw Errors.forbidden("Creator and approver must differ (segregation of duties).");
  }

  const status = body.action === "approve" ? "APPROVED" : "REJECTED";
  const updated = await db.payrollAdjustment.update({
    where: { id },
    data: { status, approvedById: user.id, approvedAt: new Date() },
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: body.action === "approve" ? "PAYROLL_ADJUSTMENT_APPROVED" : "PAYROLL_ADJUSTMENT_REJECTED",
    resourceType: "PAYROLL_ADJUSTMENT", resourceId: id,
    metadata: { run: adjustment.run.code, amountCents: adjustment.amountCents, direction: adjustment.direction, reason: adjustment.reason },
  });
  await emit({ type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "PayrollRun", resourceId: adjustment.runId, payload: { kind: "ADJUSTMENT", status }, actorType: "USER", actorId: user.id });
  return ok(updated);
});
