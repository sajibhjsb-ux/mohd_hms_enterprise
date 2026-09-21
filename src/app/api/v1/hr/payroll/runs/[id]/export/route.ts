// MOHD.HMS ENTERPRISE — Payroll run CSV export (spec §43). RBAC + salary
// privacy respected (payroll.read); the export is audited (§49). Formats
// follow the existing reports CSV conventions (cents → 2dp dollars).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
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

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const dollars = (cents: number): string => (cents / 100).toFixed(2);

export const GET = withId(PERMISSIONS.payroll_read, async (id, { user }) => {
  const run = await db.payrollRun.findUnique({ where: { id } });
  if (!run) throw Errors.notFound("Payroll run not found.");
  const items = await db.payrollItem.findMany({ where: { runId: id }, orderBy: { employeeNo: "asc" } });

  const header = [
    "Employee No", "Employee", "Department", "Position",
    "Working Days", "Worked Days", "Paid Leave", "Unpaid Leave", "Overtime Hours",
    "Basic", "Allowances", "Overtime", "Adjustments (Earnings)",
    "Gross", "Statutory", "Other Deductions", "Adjustments (Deductions)",
    "Total Deductions", "Net", "Employer Cost", "Status",
  ];
  const rows = items.map((i) => [
    i.employeeNo, i.employeeName, i.departmentName, i.positionName,
    i.workingDays, i.workedDays, i.paidLeaveDays, i.unpaidLeaveDays, (i.otMinutes / 60).toFixed(2),
    dollars(i.basicCents), dollars(i.allowancesCents), dollars(i.overtimeCents), dollars(i.adjustmentsEarningsCents),
    dollars(i.grossCents), dollars(i.statutoryCents), dollars(i.otherDeductionsCents), dollars(i.adjustmentsDeductionsCents),
    dollars(i.deductionsCents), dollars(i.netCents), dollars(i.employerCostCents), i.status,
  ]);
  const csv = "\uFEFF" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");

  await audit({
    actorId: user.id, actorEmail: user.email, action: "PAYROLL_EXPORTED",
    resourceType: "PAYROLL_RUN", resourceId: id,
    metadata: { code: run.code, rows: rows.length },
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-${run.code}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
