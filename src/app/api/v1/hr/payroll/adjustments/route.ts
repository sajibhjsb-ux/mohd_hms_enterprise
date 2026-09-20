// MOHD.HMS ENTERPRISE — Payroll adjustments (spec §24). Every adjustment has
// employee + run + amount + type + reason + creator + (on approval) approver.
// Created PENDING by payroll.manage; approved/rejected by payroll.approve;
// approved adjustments enter the run on the next calculation.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { audit, notify } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { toCents } from "@/lib/hms/format";

export const GET = handler(async ({ req }) => {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  const employeeId = url.searchParams.get("employeeId");
  const status = url.searchParams.get("status");
  const where = {
    ...(runId ? { runId } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(status ? { status } : {}),
  };
  const adjustments = await db.payrollAdjustment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 300,
    include: {
      employee: { select: { employeeNo: true, firstName: true, lastName: true } },
      run: { select: { code: true, name: true, status: true } },
    },
  });
  return ok(adjustments.map((a) => ({
    ...a,
    employeeNo: a.employee.employeeNo,
    employeeName: `${a.employee.firstName} ${a.employee.lastName}`.trim(),
    employee: undefined,
  })));
}, { permission: PERMISSIONS.payroll_read });

const createSchema = z.object({
  runId: z.string().min(1),
  employeeId: z.string().min(1),
  direction: z.enum(["EARNING", "DEDUCTION"]),
  category: z.enum(["ARREAR", "CORRECTION", "RETROACTIVE", "BONUS", "REIMBURSEMENT", "OTHER"]),
  amount: z.union([z.coerce.number().positive(), z.string()]),
  reason: z.string().trim().min(3).max(300),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);
  const run = await db.payrollRun.findUnique({ where: { id: body.runId } });
  if (!run) throw Errors.notFound("Payroll run not found.");
  if (!["DRAFT", "REVIEW", "FAILED"].includes(run.status)) {
    throw Errors.invalidTransition(
      `Adjustments target draft/under-review runs only — ${humanize(run.status)} payroll is corrected via a new adjustment cycle (§27/§50).`,
    );
  }
  const employee = await db.employee.findUnique({ where: { id: body.employeeId } });
  if (!employee) throw Errors.notFound("Employee not found.");

  const amountCents = toCents(body.amount);
  if (amountCents <= 0) throw Errors.badRequest("Adjustment amount must be positive.");

  const adjustment = await db.payrollAdjustment.create({
    data: {
      runId: run.id,
      employeeId: employee.id,
      direction: body.direction,
      category: body.category,
      amountCents,
      reason: body.reason,
      createdById: user.id,
    },
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "PAYROLL_ADJUSTMENT_CREATED",
    resourceType: "PAYROLL_ADJUSTMENT", resourceId: adjustment.id,
    metadata: { run: run.code, employeeNo: employee.employeeNo, direction: body.direction, category: body.category, amountCents, reason: body.reason },
  });
  await emit({ type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "PayrollRun", resourceId: run.id, payload: { kind: "ADJUSTMENT" }, actorType: "USER", actorId: user.id });

  // Notify the preparer-approver loop (existing NotificationService, §56).
  const approvers = await db.user.findMany({ where: { role: { in: ["FINANCE", "SUPER_ADMIN", "ADMIN"] }, status: "ACTIVE" }, select: { id: true } });
  for (const a of approvers) {
    await notify({
      userId: a.id,
      title: "Payroll adjustment pending approval",
      message: `${body.direction === "EARNING" ? "Earning" : "Deduction"} adjustment for ${employee.firstName} ${employee.lastName} (${run.code}) awaits approval.`,
      type: "INFO", resourceType: "PAYROLL_ADJUSTMENT", resourceId: adjustment.id,
    });
  }
  return ok(adjustment, 201);
}, { permission: PERMISSIONS.payroll_manage });
