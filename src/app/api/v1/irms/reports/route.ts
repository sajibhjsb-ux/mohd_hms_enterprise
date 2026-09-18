import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS, PRIORITIES } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit, nextNumber } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { overdueWhere, startOfToday } from "@/lib/hms/irms/storage";

const REPORT_TYPES = ["ROUTINE", "SAFETY", "EQUIPMENT", "PROJECT", "OTHER"] as const;
const CONDITIONS = ["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"] as const;
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const listInclude = {
  project: { select: { id: true, code: true, name: true, customerId: true, customer: { select: { companyName: true } } } },
  equipment: { select: { id: true, name: true, assetTag: true } },
  inspector: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
  workOrder: { select: { id: true, code: true } },
  _count: { select: { photos: true, findings: true } },
} as const;

// ── 1. GET /api/v1/irms/reports (STAFF_READ) ────────────────────────────────

export const GET = handler(
  async ({ req, user }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const projectId = (sp.get("projectId") ?? "").trim();
    const inspectorId = (sp.get("inspectorId") ?? "").trim();
    const type = (sp.get("type") ?? "").trim();
    const priority = (sp.get("priority") ?? "").trim();
    const overdue = sp.get("overdue") === "1";
    const mine = sp.get("mine") === "1";
    const from = (sp.get("from") ?? "").trim();
    const to = (sp.get("to") ?? "").trim();

    const where: Record<string, unknown> = {};
    if (q.status) where.status = { in: q.status.split(",").map((s) => s.trim()).filter(Boolean) };
    if (projectId) where.projectId = projectId;
    if (inspectorId) where.inspectorId = inspectorId;
    if (type) where.type = type;
    if (priority) where.priority = priority;
    if (overdue) Object.assign(where, overdueWhere());
    if (mine) where.inspector = { is: { userId: user.id } };
    if (from || to) {
      const inspectionDate: Record<string, unknown> = {};
      if (from) {
        const d = new Date(`${from}T00:00:00`);
        if (!isNaN(d.getTime())) inspectionDate.gte = d;
      }
      if (to) {
        const d = new Date(`${to}T23:59:59.999`);
        if (!isNaN(d.getTime())) inspectionDate.lte = d;
      }
      if (Object.keys(inspectionDate).length > 0) where.inspectionDate = inspectionDate;
    }
    if (q.search) {
      where.OR = [
        { code: { contains: q.search } },
        { title: { contains: q.search } },
        { project: { is: { name: { contains: q.search } } } },
      ];
    }

    const dir = q.dir === "asc" ? ("asc" as const) : ("desc" as const);
    const [items, total, grouped, overdueCount, activeProjects] = await Promise.all([
      db.inspectionReport.findMany({
        where,
        include: listInclude,
        orderBy: { inspectionDate: dir },
        skip: q.skip,
        take: q.take,
      }),
      db.inspectionReport.count({ where }),
      db.inspectionReport.groupBy({ by: ["status"], _count: { _all: true } }),
      db.inspectionReport.count({ where: overdueWhere() }),
      db.irmsProject.count({ where: { status: "ACTIVE" } }),
    ]);

    const byStatus = new Map(grouped.map((g) => [g.status, g._count._all]));
    const pick = (...statuses: string[]) => statuses.reduce((sum, s) => sum + (byStatus.get(s) ?? 0), 0);
    const stats = {
      total: total,
      drafts: pick("DRAFT"),
      pendingReview: pick("SUBMITTED", "IN_REVIEW", "MANAGER_APPROVAL", "CLIENT_REVIEW"),
      approved: pick("APPROVED"),
      rejected: pick("REJECTED"),
      archived: pick("ARCHIVED"),
      overdue: overdueCount,
      activeProjects,
    };

    return okList(
      items.map((r) => ({ ...r, photosCount: r._count.photos, findingsCount: r._count.findings })),
      { ...pagedMeta(q.page, q.pageSize, total), stats, generatedAt: startOfToday().toISOString() }
    );
  },
  { permission: PERMISSIONS.irms_read }
);

// ── 2. POST /api/v1/irms/reports (CREATE) ───────────────────────────────────

const findingSchema = z.object({
  finding: z.string().min(1, "Finding text is required.").max(2000),
  severity: z.enum(SEVERITIES).default("MEDIUM"),
  recommendation: z.string().max(2000).optional(),
});

const createSchema = z.object({
  projectId: z.string().min(1, "Project is required."),
  equipmentId: z.string().min(1).nullish(),
  workOrderId: z.string().min(1).nullish(),
  title: z.string().min(1, "Title is required.").max(200),
  type: z.enum(REPORT_TYPES),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  inspectionDate: z.string().min(1, "Inspection date is required."),
  inspectorId: z.string().min(1).nullish(),
  summary: z.string().max(8000).nullish(),
  overallCondition: z.enum(CONDITIONS).nullish(),
  recommendations: z.string().max(8000).nullish(),
  customerVisible: z.boolean().nullish(),
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
  labourHours: z.coerce.number().min(0).max(9999).default(0),
  completionPercent: z.coerce.number().int().min(0).max(100).default(0),
  findings: z.array(findingSchema).max(50).default([]),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    const project = await db.irmsProject.findUnique({ where: { id: body.projectId } });
    if (!project) throw Errors.badRequest("Selected project does not exist.");
    if (body.equipmentId) {
      const equipment = await db.equipment.findUnique({ where: { id: body.equipmentId } });
      if (!equipment) throw Errors.badRequest("Selected equipment does not exist.");
    }
    if (body.workOrderId) {
      const wo = await db.workOrder.findUnique({ where: { id: body.workOrderId } });
      if (!wo) throw Errors.badRequest("Selected work order does not exist.");
    }

    const canManage = roleCan(user.role, PERMISSIONS.irms_manage);
    const ownProfile = await db.technicianProfile.findUnique({ where: { userId: user.id } });

    // inspectorId defaults to the caller's own technician profile; only MANAGE
    // may assign someone else (contract §2).
    let inspectorId = ownProfile?.id ?? null;
    if (body.inspectorId) {
      if (!canManage) throw Errors.forbidden("Only supervisors/admins can assign a different inspector.");
      const target = await db.technicianProfile.findUnique({ where: { id: body.inspectorId } });
      if (!target) throw Errors.badRequest("Selected inspector does not exist.");
      inspectorId = target.id;
    }
    if (!inspectorId) {
      throw Errors.badRequest(
        "No inspector could be determined. Your account has no technician profile — ask a supervisor to create one or select an inspector explicitly."
      );
    }

    const inspectionDate = new Date(body.inspectionDate);
    if (isNaN(inspectionDate.getTime())) throw Errors.badRequest("Inspection date is invalid.");

    const code = await nextNumber("INS");
    const report = await db.inspectionReport.create({
      data: {
        code,
        projectId: body.projectId,
        equipmentId: body.equipmentId ?? null,
        workOrderId: body.workOrderId ?? null,
        title: body.title,
        type: body.type,
        priority: body.priority,
        inspectionDate,
        inspectorId,
        status: "DRAFT",
        summary: body.summary ?? "",
        overallCondition: body.overallCondition ?? "GOOD",
        recommendations: body.recommendations ?? "",
        customerVisible: body.customerVisible ?? false,
        jobOrderNo: body.jobOrderNo ?? "",
        building: body.building ?? "",
        floor: body.floor ?? "",
        room: body.room ?? "",
        taskDescription: body.taskDescription ?? "",
        scope: body.scope ?? "",
        notes: body.notes ?? "",
        correctiveActions: body.correctiveActions ?? "",
        rootCause: body.rootCause ?? "",
        safetyNotes: body.safetyNotes ?? "",
        materials: body.materials ?? "",
        labourHours: body.labourHours,
        completionPercent: body.completionPercent,
        findings: {
          create: body.findings.map((f) => ({
            finding: f.finding,
            severity: f.severity,
            recommendation: f.recommendation ?? "",
          })),
        },
      },
      select: { id: true, code: true },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_CREATED",
      resourceType: "INSPECTION_REPORT",
      resourceId: report.id,
      metadata: { code, projectId: body.projectId, type: body.type, priority: body.priority, findings: body.findings.length },
    });

    // Realtime (STEP 16): IRMS staff views update live.
    await emit({
      type: EVENT_TYPES.IRMS_REPORT_UPDATED,
      resourceType: "INSPECTION_REPORT",
      resourceId: report.id,
      payload: { reportId: report.id, code, status: "DRAFT" },
      actorType: "USER",
      actorId: user.id,
    });
    return NextResponse.json({ ok: true, data: { id: report.id, code: report.code } }, { status: 201 });
  },
  { permission: PERMISSIONS.irms_create }
);
