// MOHD.HMS ENTERPRISE — Payroll dashboard KPIs (spec §31). Real PostgreSQL
// aggregates only — no fake numbers.

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(async () => {
  const [totalEmployees, payrollEmployees, runs, latestRuns, pendingAdjustments, pendingOvertime, statutoryCount, componentCount] =
    await Promise.all([
      db.employee.count(),
      db.employee.count({ where: { status: { not: "TERMINATED" } } }),
      db.payrollRun.groupBy({ by: ["status"], _count: { _all: true } }),
      db.payrollRun.findMany({
        orderBy: { periodStart: "desc" },
        take: 6,
        include: { creator: { select: { name: true } }, approver: { select: { name: true } } },
      }),
      db.payrollAdjustment.count({ where: { status: "PENDING" } }),
      db.overtimeRequest.count({ where: { status: "PENDING" } }),
      db.statutoryRule.count({ where: { active: true } }),
      db.salaryComponent.count({ where: { active: true } }),
    ]);

  const statusCounts: Record<string, number> = {};
  for (const g of runs) statusCounts[g.status] = g._count._all;

  const current = latestRuns[0] ?? null;

  return ok({
    totalEmployees,
    payrollEmployees,
    current: current
      ? {
          id: current.id,
          code: current.code,
          name: current.name,
          periodKey: current.periodKey,
          status: current.status,
          employeeCount: current.employeeCount,
          grossCents: current.grossCents,
          deductionsCents: current.deductionsCents,
          employerCostCents: current.employerCostCents,
          netCents: current.netCents,
          exceptionCount: current.exceptionCount,
          creatorName: current.creator?.name ?? "",
          approverName: current.approver?.name ?? "",
        }
      : null,
    statusCounts,
    runs: latestRuns.map((r) => ({
      id: r.id, code: r.code, name: r.name, periodStart: r.periodStart, periodEnd: r.periodEnd,
      status: r.status, employeeCount: r.employeeCount, grossCents: r.grossCents,
      deductionsCents: r.deductionsCents, netCents: r.netCents,
      creatorName: r.creator?.name ?? "", approverName: r.approver?.name ?? "",
    })),
    pendingAdjustments,
    pendingOvertime,
    statutoryCount,
    componentCount,
  });
}, { permission: PERMISSIONS.payroll_read });
