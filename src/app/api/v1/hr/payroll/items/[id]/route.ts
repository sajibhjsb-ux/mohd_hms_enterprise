// MOHD.HMS ENTERPRISE — Employee payroll item detail (spec §34/§48).
// Full traceability: every figure comes from identifiable component lines.
// Owner (linked account) or payroll.read holders; others denied (§30).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import type { PayrollLine } from "@/lib/hms/payroll/config";

const withId = (
  permission: Permission | null,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission: permission ?? undefined })(req);
  };
};

function safeLines(json: string): PayrollLine[] {
  try {
    const parsed = JSON.parse(json || "[]") as PayrollLine[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const GET = withId(null, async (id, { user }) => {
  const item = await db.payrollItem.findUnique({
    where: { id },
    include: {
      employee: { select: { userId: true } },
      run: { select: { id: true, code: true, name: true, periodStart: true, periodEnd: true, status: true, payDate: true, paymentRef: true } },
    },
  });
  if (!item) throw Errors.notFound("Payroll item not found.");

  const isOwner = !!item.employee.userId && item.employee.userId === user.id;
  const canReadAll = roleCan(user.role, PERMISSIONS.payroll_read);
  if (!isOwner && !canReadAll) throw Errors.forbidden("You can only view your own payroll details.");

  return ok({
    ...item,
    employee: undefined,
    lines: safeLines(item.linesJson),
    linesJson: undefined,
    // Review internals are for payroll readers only (own payslip stays clean).
    exceptionFlags: undefined,
    varianceBps: canReadAll ? item.varianceBps : null,
  });
});
