import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";

const REPORT_TYPES = ["ROUTINE", "SAFETY", "EQUIPMENT", "PROJECT", "OTHER"] as const;
const CONDITIONS = ["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"] as const;
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const projectId = (sp.get("projectId") ?? "").trim();
    const type = (sp.get("type") ?? "").trim();

    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (projectId) where.projectId = projectId;
    if (type) where.type = type;
    if (q.search) {
      where.OR = [
        { code: { contains: q.search } },
        { title: { contains: q.search } },
        { project: { is: { name: { contains: q.search } } } },
      ];
    }

    const dir = q.dir === "asc" ? ("asc" as const) : ("desc" as const);
    const [items, total] = await Promise.all([
      db.inspectionReport.findMany({
        where,
        include: {
          project: { select: { id: true, name: true, code: true } },
          equipment: { select: { id: true, name: true, assetTag: true } },
          inspector: { select: { id: true, user: { select: { name: true } } } },
          _count: { select: { findings: true } },
        },
        orderBy: { inspectionDate: dir },
        skip: q.skip,
        take: q.take,
      }),
      db.inspectionReport.count({ where }),
    ]);

    return okList(
      items.map((r) => ({ ...r, findingsCount: r._count.findings })),
      pagedMeta(q.page, q.pageSize, total)
    );
  },
  { permission: PERMISSIONS.irms_read }
);

const findingSchema = z.object({
  finding: z.string().min(1, "Finding text is required."),
  severity: z.enum(SEVERITIES).default("MEDIUM"),
  recommendation: z.string().max(2000).optional(),
});

const createSchema = z.object({
  projectId: z.string().min(1, "Project is required."),
  equipmentId: z.string().min(1).nullish(),
  title: z.string().min(2, "Title is required."),
  type: z.enum(REPORT_TYPES),
  inspectionDate: z.string().nullish(),
  summary: z.string().max(8000).nullish(),
  overallCondition: z.enum(CONDITIONS).nullish(),
  recommendations: z.string().max(8000).nullish(),
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

    // Inspector is the reporting staff member's linked technician profile (if any)
    const profile = await db.technicianProfile.findUnique({ where: { userId: user.id } });

    const code = await nextNumber("INS");
    const inspectionDate = body.inspectionDate ? new Date(body.inspectionDate) : new Date();
    if (isNaN(inspectionDate.getTime())) throw Errors.badRequest("Inspection date is invalid.");

    const report = await db.inspectionReport.create({
      data: {
        code,
        projectId: body.projectId,
        equipmentId: body.equipmentId ?? null,
        title: body.title,
        type: body.type,
        inspectionDate,
        inspectorId: profile?.id ?? null,
        status: "DRAFT",
        summary: body.summary ?? "",
        overallCondition: body.overallCondition ?? "GOOD",
        recommendations: body.recommendations ?? "",
        findings: {
          create: body.findings.map((f) => ({
            finding: f.finding,
            severity: f.severity,
            recommendation: f.recommendation ?? "",
          })),
        },
      },
      include: {
        project: { select: { id: true, name: true, code: true } },
        equipment: { select: { id: true, name: true, assetTag: true } },
        inspector: { select: { id: true, user: { select: { name: true } } } },
        findings: true,
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_CREATED",
      resourceType: "InspectionReport",
      resourceId: report.id,
      metadata: { code, projectId: body.projectId, type: body.type, findings: body.findings.length },
    });

    return ok(report, 201);
  },
  { permission: PERMISSIONS.irms_manage }
);
