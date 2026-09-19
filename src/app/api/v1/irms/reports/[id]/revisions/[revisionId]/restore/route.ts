import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { isEditableStatus, parseSnapshot, type TxClient } from "@/lib/hms/irms/storage";

async function restore(id: string, revisionId: string, user: SessionUser) {
  const report = await db.inspectionReport.findUnique({ where: { id } });
  if (!report) throw Errors.notFound("Inspection report not found.");
  if (!isEditableStatus(report.status)) {
    throw Errors.invalidTransition("Revisions can only be restored on draft or rejected reports.");
  }

  const revision = await db.inspectionRevision.findUnique({ where: { id: revisionId } });
  if (!revision || revision.reportId !== id) throw Errors.notFound("Revision not found.");
  const parsed = parseSnapshot(revision.snapshot);
  if (!parsed) throw Errors.badRequest("The stored snapshot is corrupt and cannot be restored.");

  const r = parsed.report as Record<string, unknown>;
  const dateish = (v: unknown): Date | undefined => {
    if (typeof v !== "string" && !(v instanceof Date)) return undefined;
    const d = new Date(v as string);
    return isNaN(d.getTime()) ? undefined : d;
  };

  await db.$transaction(async (tx: TxClient) => {
    // Report fields only — photos / signatures / approvals are untouched (§7).
    await tx.inspectionReport.update({
      where: { id },
      data: {
        ...(typeof r.title === "string" ? { title: r.title } : {}),
        ...(typeof r.type === "string" ? { type: r.type } : {}),
        ...(typeof r.priority === "string" ? { priority: r.priority } : {}),
        ...(dateish(r.inspectionDate) ? { inspectionDate: dateish(r.inspectionDate) } : {}),
        ...(typeof r.inspectorId === "string" || r.inspectorId === null ? { inspectorId: (r.inspectorId as string | null) ?? null } : {}),
        ...(typeof r.equipmentId === "string" || r.equipmentId === null ? { equipmentId: (r.equipmentId as string | null) ?? null } : {}),
        ...(typeof r.workOrderId === "string" || r.workOrderId === null ? { workOrderId: (r.workOrderId as string | null) ?? null } : {}),
        ...(typeof r.summary === "string" ? { summary: r.summary } : {}),
        ...(typeof r.overallCondition === "string" ? { overallCondition: r.overallCondition } : {}),
        ...(typeof r.recommendations === "string" ? { recommendations: r.recommendations } : {}),
        ...(typeof r.jobOrderNo === "string" ? { jobOrderNo: r.jobOrderNo } : {}),
        ...(typeof r.building === "string" ? { building: r.building } : {}),
        ...(typeof r.floor === "string" ? { floor: r.floor } : {}),
        ...(typeof r.room === "string" ? { room: r.room } : {}),
        ...(typeof r.taskDescription === "string" ? { taskDescription: r.taskDescription } : {}),
        ...(typeof r.scope === "string" ? { scope: r.scope } : {}),
        ...(typeof r.notes === "string" ? { notes: r.notes } : {}),
        ...(typeof r.correctiveActions === "string" ? { correctiveActions: r.correctiveActions } : {}),
        ...(typeof r.rootCause === "string" ? { rootCause: r.rootCause } : {}),
        ...(typeof r.safetyNotes === "string" ? { safetyNotes: r.safetyNotes } : {}),
        ...(typeof r.materials === "string" ? { materials: r.materials } : {}),
        ...(typeof r.labourHours === "number" ? { labourHours: r.labourHours } : {}),
        ...(typeof r.completionPercent === "number" ? { completionPercent: r.completionPercent } : {}),
        ...(typeof r.customerVisible === "boolean" ? { customerVisible: r.customerVisible } : {}),
        ...(typeof r.clientComment === "string" ? { clientComment: r.clientComment } : {}),
      },
    });
    await tx.inspectionFinding.deleteMany({ where: { reportId: id } });
    if (parsed.findings.length > 0) {
      await tx.inspectionFinding.createMany({
        data: parsed.findings.map((f) => ({
          reportId: id,
          finding: String(f.finding ?? ""),
          severity: String(f.severity ?? "MEDIUM"),
          recommendation: String(f.recommendation ?? ""),
        })),
      });
    }
    await emit({
      type: EVENT_TYPES.IRMS_REPORT_UPDATED,
      resourceType: "INSPECTION_REPORT",
      resourceId: id,
      payload: { reportId: id, code: report.code, status: report.status },
      actorType: "USER",
      actorId: user.id,
      tx,
    });
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "INSPECTION_REVISION_RESTORED",
    resourceType: "INSPECTION_REPORT",
    resourceId: id,
    metadata: { code: report.code, revisionId, version: revision.version },
  });
  return ok({ id, restoredFrom: revision.version, code: report.code });
}

export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string; revisionId: string }> }) => {
  const { id, revisionId } = await ctx.params;
  return handler((c) => restore(id, revisionId, c.user), { permission: PERMISSIONS.irms_manage })(req);
};
