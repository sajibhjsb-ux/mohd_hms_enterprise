// MOHD.HMS ENTERPRISE — Payslip generation (spec §35/§36/§38).
// POST renders payslips for a FINALIZED+ run with the EXISTING PdfDoc engine
// and stores the immutable PDFs in MinIO via the EXISTING storage service
// (metadata in PostgreSQL on the item — the letters-finalize pattern).
// Each employee is notified through the EXISTING NotificationService (§38) —
// never any sensitive figures in the notification itself (§57).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { audit, notify } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { storage } from "@/lib/hms/storage";
import { getBranding } from "@/lib/hms/pdf/branding";
import { buildPayslipPdf } from "@/lib/hms/payroll/payslip";
import { periodLabel } from "@/lib/hms/payroll/engine";

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
  if (!["FINALIZED", "PAID", "LOCKED"].includes(run.status)) {
    throw Errors.notFound("Payslips can only be generated after the run is FINALIZED (spec §9).");
  }

  const items = await db.payrollItem.findMany({
    where: { runId: id, status: "CALCULATED" },
    include: { employee: { select: { userId: true } } },
    orderBy: { employeeNo: "asc" },
  });
  if (items.length === 0) throw Errors.badRequest("No calculated items in this run.");

  const branding = await getBranding();
  const period = periodLabel(run.periodStart);
  let generated = 0;
  const failures: { employeeNo: string; error: string }[] = [];

  for (const item of items) {
    try {
      const pdf = await buildPayslipPdf(item, run, branding);
      if (pdf.bytes[0] !== 0x25 || pdf.bytes[1] !== 0x50) throw new Error("Invalid PDF header"); // "%P"
      const key = `payslips/${run.periodKey}/${item.id}.pdf`;
      await storage.put(key, Buffer.from(pdf.bytes), "application/pdf");
      await db.payrollItem.update({
        where: { id: item.id },
        data: { payslipObjectKey: key, payslipSizeBytes: pdf.bytes.length, payslipGeneratedAt: new Date() },
      });
      generated += 1;

      // §38 — existing notification pipeline (in-app + email + push per prefs).
      if (item.employee.userId) {
        await notify({
          userId: item.employee.userId,
          title: "Payslip available",
          message: `Your ${period} payslip is now available.`,
          type: "INFO",
          channels: ["IN_APP", "EMAIL", "PUSH"],
          resourceType: "PAYROLL_ITEM",
          resourceId: item.id,
        });
      }
      await emit({
        type: EVENT_TYPES.PAYSLIP_PUBLISHED, resourceType: "PayrollItem", resourceId: item.id,
        payload: { runCode: run.code, employeeNo: item.employeeNo }, actorType: "USER", actorId: user.id,
      });
    } catch (err) {
      failures.push({ employeeNo: item.employeeNo, error: err instanceof Error ? err.message : "render failed" });
    }
  }

  await audit({
    actorId: user.id, actorEmail: user.email, action: "PAYSLIPS_GENERATED",
    resourceType: "PAYROLL_RUN", resourceId: id,
    metadata: { code: run.code, generated, failed: failures.length },
  });

  return ok({ generated, failed: failures.length, failures });
});
