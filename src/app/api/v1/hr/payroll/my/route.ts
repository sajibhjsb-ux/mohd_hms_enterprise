// MOHD.HMS ENTERPRISE — Employee payroll self-service (spec §51).
// Authenticated staff with a linked Employee record see THEIR OWN payslips,
// salary history and deductions. Employees never see another employee's data;
// users without an employee link (e.g. CUSTOMER portals) get an empty result.

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { humanize } from "@/lib/hms/constants";
import type { PayrollLine } from "@/lib/hms/payroll/config";

function safeLines(json: string): PayrollLine[] {
  try {
    const parsed = JSON.parse(json || "[]") as PayrollLine[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const GET = handler(async ({ user }) => {
  const employee = await db.employee.findUnique({ where: { userId: user.id } });
  if (!employee) return ok({ hasEmployeeRecord: false, payslips: [], salary: [] });

  const [items, salary] = await Promise.all([
    db.payrollItem.findMany({
      where: { employeeId: employee.id },
      orderBy: [{ run: { periodStart: "desc" } }],
      include: {
        run: { select: { code: true, name: true, periodStart: true, periodEnd: true, status: true, payDate: true, paymentRef: true } },
      },
    }),
    db.salaryStructure.findMany({
      where: { employeeId: employee.id },
      orderBy: { effectiveFrom: "desc" },
      include: { component: { select: { name: true, category: true, type: true } } },
    }),
  ]);

  return ok({
    hasEmployeeRecord: true,
    employee: {
      employeeNo: employee.employeeNo,
      name: `${employee.firstName} ${employee.lastName}`.trim(),
      departmentName: null as string | null,
      position: employee.position,
      currentBasicCents: employee.salaryCents,
    },
    payslips: items.map((i) => ({
      id: i.id,
      runCode: i.run.code,
      runName: i.run.name,
      periodStart: i.run.periodStart,
      periodEnd: i.run.periodEnd,
      periodStatus: humanize(i.run.status),
      payDate: i.run.payDate,
      paymentRef: i.run.paymentRef,
      status: i.status,
      grossCents: i.grossCents,
      deductionsCents: i.deductionsCents,
      netCents: i.netCents,
      hasPayslipPdf: !!i.payslipObjectKey,
      payslipGeneratedAt: i.payslipGeneratedAt,
      lines: safeLines(i.linesJson),
    })),
    salary: salary.map((s) => ({
      id: s.id,
      component: s.component.name,
      category: s.component.category,
      type: s.component.type,
      amountCents: s.amountCents,
      percentBps: s.percentBps,
      effectiveFrom: s.effectiveFrom,
      effectiveTo: s.effectiveTo,
      note: s.note,
    })),
  });
});
