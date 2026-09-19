import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS, PRIORITIES } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import {
  canonicalPhotoOrder,
  deleteReportDir,
  isEditableStatus,
  photoItemDto,
  type TxClient,
} from "@/lib/hms/irms/storage";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const conditions = ["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"] as const;
const severities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const reportTypes = ["ROUTINE", "SAFETY", "EQUIPMENT", "PROJECT", "OTHER"] as const;

const detailInclude = {
  project: { include: { customer: { select: { id: true, companyName: true, contactPerson: true, email: true, phone: true } } } },
  equipment: { select: { id: true, name: true, assetTag: true } },
  workOrder: { select: { id: true, code: true, title: true, customerId: true } },
  inspector: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
  findings: { orderBy: { id: "asc" as const } },
  photos: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
  signatures: { orderBy: { signedAt: "desc" as const } },
  approvals: { orderBy: { createdAt: "desc" as const } },
  revisions: {
    orderBy: { version: "desc" as const },
    select: { id: true, version: true, note: true, createdByName: true, createdAt: true },
  },
};

// ── 3. GET /api/v1/irms/reports/[id] (STAFF_READ) — full detail ─────────────

export const GET = withId(
  async (id) => {
    const report = await db.inspectionReport.findUnique({ where: { id }, include: detailInclude });
    if (!report) throw Errors.notFound("Inspection report not found.");
    return ok({
      ...report,
      photos: canonicalPhotoOrder(report.photos).map((p) => photoItemDto(p)),
      signatures: report.signatures.map((s) => ({
        id: s.id,
        role: s.role,
        name: s.name,
        signedAt: s.signedAt,
        revision: s.revision,
        url: `/api/v1/irms/signatures/${s.id}/file`,
      })),
    });
  },
  PERMISSIONS.irms_read
);

const findingSchema = z.object({
  finding: z.string().min(1, "Finding text is required.").max(2000),
  severity: z.enum(severities).default("MEDIUM"),
  recommendation: z.string().max(2000).optional(),
});

const patchSchema = z.object({
  projectId: z.string().min(1).optional(),
  equipmentId: z.string().min(1).nullish(),
  workOrderId: z.string().min(1).nullish(),
  title: z.string().min(1).max(200).optional(),
  type: z.enum(reportTypes).optional(),
  priority: z.enum(PRIORITIES).optional(),
  inspectionDate: z.string().nullish(),
  inspectorId: z.string().min(1).nullish(),
  summary: z.string().max(8000).nullish(),
  overallCondition: z.enum(conditions).nullish(),
  recommendations: z.string().max(8000).nullish(),
  customerVisible: z.boolean().optional(),
  jobOrderNo: z.string().max(120).nullish(),
  building: z.string().max(160).nullish(),
  floor: z.string().max(120).nullish(),
  room: z.string().max(120).nullish(),
  taskDescription: z.string().max(8000).nullish(),
  scope: z.string().max(8000).nullish(),
  notes: z.string().max(8000).nullish(),
  correctiveActions: z.string().max(8000).nullish(),
  rootCause: z.string().max(8000).nullish(),
  safetyNotes: z.string().max(8000).nullish(),
  materials: z.string().max(4000).nullish(),
  labourHours: z.coerce.number().min(0).max(9999).optional(),
  completionPercent: z.coerce.number().int().min(0).max(100).optional(),
  findings: z.array(findingSchema).max(50).optional(),
});

// ── 4. PATCH (CREATE owner | MANAGE any) — editable reports only → else 422 ──

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);

    const report = await db.inspectionReport.findUnique({
      where: { id },
      include: { inspector: { select: { id: true, userId: true } } },
    });
    if (!report) throw Errors.notFound("Inspection report not found.");

    const canManage = roleCan(user.role, PERMISSIONS.irms_manage);
    const isOwner = !!report.inspector && report.inspector.userId === user.id;
    if (!canManage && !(roleCan(user.role, PERMISSIONS.irms_create) && isOwner)) {
      throw Errors.forbidden("Only the owning inspector or a supervisor can edit this report.");
    }
    if (!isEditableStatus(report.status)) {
      throw Errors.invalidTransition("Only draft or rejected reports can be edited. The review flow has already started.");
    }

    if (body.projectId && body.projectId !== report.projectId) {
      const project = await db.irmsProject.findUnique({ where: { id: body.projectId } });
      if (!project) throw Errors.badRequest("Selected project does not exist.");
    }
    if (body.equipmentId) {
      const equipment = await db.equipment.findUnique({ where: { id: body.equipmentId } });
      if (!equipment) throw Errors.badRequest("Selected equipment does not exist.");
    }
    if (body.workOrderId) {
      const wo = await db.workOrder.findUnique({ where: { id: body.workOrderId } });
      if (!wo) throw Errors.badRequest("Selected work order does not exist.");
    }
    if (body.inspectorId) {
      if (!canManage) throw Errors.forbidden("Only supervisors/admins can assign a different inspector.");
      const target = await db.technicianProfile.findUnique({ where: { id: body.inspectorId } });
      if (!target) throw Errors.badRequest("Selected inspector does not exist.");
    }
    let inspectionDate: Date | undefined;
    if (body.inspectionDate !== undefined && body.inspectionDate !== null) {
      inspectionDate = new Date(body.inspectionDate);
      if (isNaN(inspectionDate.getTime())) throw Errors.badRequest("Inspection date is invalid.");
    }

    const str = (v: string | null | undefined) => (v === undefined ? undefined : v ?? "");
    const updated = await db.$transaction(async (tx: TxClient) => {
      // findings present ⇒ full replace (contract §4)
      if (body.findings) {
        await tx.inspectionFinding.deleteMany({ where: { reportId: id } });
        if (body.findings.length > 0) {
          await tx.inspectionFinding.createMany({
            data: body.findings.map((f) => ({
              reportId: id,
              finding: f.finding,
              severity: f.severity,
              recommendation: f.recommendation ?? "",
            })),
          });
        }
      }
      return tx.inspectionReport.update({
        where: { id },
        data: {
          ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
          ...(body.equipmentId !== undefined ? { equipmentId: body.equipmentId ?? null } : {}),
          ...(body.workOrderId !== undefined ? { workOrderId: body.workOrderId ?? null } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.inspectionDate !== undefined ? { inspectionDate: inspectionDate ?? report.inspectionDate } : {}),
          ...(body.inspectorId !== undefined ? { inspectorId: body.inspectorId ?? null } : {}),
          ...(body.summary !== undefined ? { summary: str(body.summary) } : {}),
          ...(body.overallCondition !== undefined ? { overallCondition: body.overallCondition ?? "GOOD" } : {}),
          ...(body.recommendations !== undefined ? { recommendations: str(body.recommendations) } : {}),
          ...(body.customerVisible !== undefined ? { customerVisible: body.customerVisible } : {}),
          ...(body.jobOrderNo !== undefined ? { jobOrderNo: str(body.jobOrderNo) } : {}),
          ...(body.building !== undefined ? { building: str(body.building) } : {}),
          ...(body.floor !== undefined ? { floor: str(body.floor) } : {}),
          ...(body.room !== undefined ? { room: str(body.room) } : {}),
          ...(body.taskDescription !== undefined ? { taskDescription: str(body.taskDescription) } : {}),
          ...(body.scope !== undefined ? { scope: str(body.scope) } : {}),
          ...(body.notes !== undefined ? { notes: str(body.notes) } : {}),
          ...(body.correctiveActions !== undefined ? { correctiveActions: str(body.correctiveActions) } : {}),
          ...(body.rootCause !== undefined ? { rootCause: str(body.rootCause) } : {}),
          ...(body.safetyNotes !== undefined ? { safetyNotes: str(body.safetyNotes) } : {}),
          ...(body.materials !== undefined ? { materials: str(body.materials) } : {}),
          ...(body.labourHours !== undefined ? { labourHours: body.labourHours } : {}),
          ...(body.completionPercent !== undefined ? { completionPercent: body.completionPercent } : {}),
        },
        include: detailInclude,
      });
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_UPDATED",
      resourceType: "INSPECTION_REPORT",
      resourceId: id,
      metadata: { code: report.code, fields: Object.keys(body) },
    });

    await emit({
      type: EVENT_TYPES.IRMS_REPORT_UPDATED,
      resourceType: "INSPECTION_REPORT",
      resourceId: id,
      payload: { reportId: id, code: report.code, status: updated.status },
      actorType: "USER",
      actorId: user.id,
    });

    return ok({
      ...updated,
      photos: canonicalPhotoOrder(updated.photos).map((p) => photoItemDto(p)),
      signatures: updated.signatures.map((s) => ({
        id: s.id,
        role: s.role,
        name: s.name,
        signedAt: s.signedAt,
        revision: s.revision,
        url: `/api/v1/irms/signatures/${s.id}/file`,
      })),
    });
  },
  // RBAC is enforced per-record above (owner | MANAGE) — no coarse gate here.
  undefined
);

// ── 5. DELETE (MANAGE | owner) — DRAFT only → else 422 ──────────────────────

export const DELETE = withId(
  async (id, { user }) => {
    const report = await db.inspectionReport.findUnique({
      where: { id },
      include: { inspector: { select: { userId: true } } },
    });
    if (!report) throw Errors.notFound("Inspection report not found.");

    const isOwner = !!report.inspector && report.inspector.userId === user.id;
    if (!roleCan(user.role, PERMISSIONS.irms_manage) && !isOwner) {
      throw Errors.forbidden("Only the owning inspector or a supervisor can delete this report.");
    }
    if (report.status !== "DRAFT") {
      throw Errors.invalidTransition("Only draft reports can be deleted.");
    }

    await db.inspectionReport.delete({ where: { id } });
    await deleteReportDir(id); // storage folder cleanup (photos + signatures)

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_DELETED",
      resourceType: "INSPECTION_REPORT",
      resourceId: id,
      metadata: { code: report.code, title: report.title },
    });
    return ok({ deleted: true, id });
  }
);
