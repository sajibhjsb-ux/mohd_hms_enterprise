// MOHD.HMS ENTERPRISE — Payroll run detail (spec §33/§44/§45).
// GET returns the run, its employee items and the review exceptions.

import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { NextRequest, NextResponse } from "next/server";
import type { SessionUser } from "@/lib/hms/auth";
import type { PayrollLine } from "@/lib/hms/payroll/config";

const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

export const GET = withId(PERMISSIONS.payroll_read, async (id) => {
  const run = await db.payrollRun.findUnique({
    where: { id },
    include: {
      creator: { select: { name: true, email: true } },
      approver: { select: { name: true, email: true } },
      payer: { select: { name: true, email: true } },
      lockUser: { select: { name: true, email: true } },
      adjustments: {
        include: { employee: { select: { employeeNo: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!run) throw Errors.notFound("Payroll run not found.");

  const items = await db.payrollItem.findMany({
    where: { runId: id },
    orderBy: { employeeNo: "asc" },
  });

  // §44 — removed-employee detection vs the previous comparable run.
  const prevRun = await db.payrollRun.findFirst({
    where: { periodEnd: { lt: run.periodStart }, status: { in: ["FINALIZED", "PAID", "LOCKED", "APPROVED", "REVIEW"] } },
    orderBy: { periodEnd: "desc" },
    select: { id: true, code: true },
  });
  let removedEmployees: { employeeNo: string; employeeName: string; prevNetCents: number }[] = [];
  if (prevRun) {
    const prevItems = await db.payrollItem.findMany({
      where: { runId: prevRun.id, status: "CALCULATED" },
      select: { employeeId: true, employeeNo: true, employeeName: true, netCents: true },
    });
    const currentIds = new Set(items.map((i) => i.employeeId));
    removedEmployees = prevItems
      .filter((p) => !currentIds.has(p.employeeId))
      .map((p) => ({ employeeNo: p.employeeNo, employeeName: p.employeeName, prevNetCents: p.netCents }));
  }

  const flagged = items
    .filter((i) => {
      try {
        return (JSON.parse(i.exceptionFlags || "[]") as string[]).length > 0;
      } catch {
        return false;
      }
    })
    .map((i) => ({
      id: i.id,
      employeeNo: i.employeeNo,
      employeeName: i.employeeName,
      netCents: i.netCents,
      varianceBps: i.varianceBps,
      flags: JSON.parse(i.exceptionFlags || "[]") as string[],
    }));

  return ok({
    ...run,
    creatorName: run.creator?.name ?? "",
    approverName: run.approver?.name ?? "",
    payerName: run.payer?.name ?? "",
    lockedByName: run.lockUser?.name ?? "",
    creator: undefined, approver: undefined, payer: undefined, lockUser: undefined,
    items: items.map((i) => ({ ...i, lines: safeLines(i.linesJson), linesJson: undefined, exceptionFlags: undefined, flags: safeFlags(i.exceptionFlags) })),
    review: {
      previousRun: prevRun ? { id: prevRun.id, code: prevRun.code } : null,
      removedEmployees,
      flaggedItems: flagged,
      exceptionCount: run.exceptionCount + removedEmployees.length,
    },
  });
});

function safeLines(json: string): PayrollLine[] {
  try {
    const parsed = JSON.parse(json || "[]") as PayrollLine[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function safeFlags(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]") as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
