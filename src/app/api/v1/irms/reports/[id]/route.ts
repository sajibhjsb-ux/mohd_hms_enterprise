import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const detailInclude = {
  project: { include: { customer: { select: { id: true, companyName: true, contactPerson: true, email: true, phone: true } } } },
  equipment: { select: { id: true, name: true, assetTag: true } },
  inspector: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true, email: true } } } },
  findings: { orderBy: { id: "asc" as const } },
} as const;

export const GET = withId(
  async (id) => {
    const report = await db.inspectionReport.findUnique({ where: { id }, include: detailInclude });
    if (!report) throw Errors.notFound("Inspection report not found.");
    return ok(report);
  },
  PERMISSIONS.irms_read
);

const findingSchema = z.object({
  finding: z.string().min(1, "Finding text is required."),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  recommendation: z.string().max(2000).optional(),
});

const patchSchema = z.object({
  title: z.string().min(2).optional(),
  equipmentId: z.string().min(1).nullish(),
  type: z.enum(["ROUTINE", "SAFETY", "EQUIPMENT", "PROJECT", "OTHER"]).optional(),
  inspectionDate: z.string().nullish(),
  summary: z.string().max(8000).nullish(),
  overallCondition: z.enum(["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"]).nullish(),
  recommendations: z.string().max(8000).nullish(),
  findings: z.array(findingSchema).max(50).optional(),
});

/** Only DRAFT reports are editable — submitted/approved reports are immutable records. */
export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const report = await db.inspectionReport.findUnique({ where: { id } });
    if (!report) throw Errors.notFound("Inspection report not found.");
    if (report.status !== "DRAFT") {
      throw Errors.invalidTransition("Only draft reports can be edited. Submit or approve flow has already started.");
    }
    if (body.equipmentId) {
      const equipment = await db.equipment.findUnique({ where: { id: body.equipmentId } });
      if (!equipment) throw Errors.badRequest("Selected equipment does not exist.");
    }
    let inspectionDate: Date | undefined;
    if (body.inspectionDate !== undefined && body.inspectionDate !== null) {
      inspectionDate = new Date(body.inspectionDate);
      if (isNaN(inspectionDate.getTime())) throw Errors.badRequest("Inspection date is invalid.");
    }

    const updated = await db.$transaction(async (tx) => {
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
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.equipmentId !== undefined ? { equipmentId: body.equipmentId ?? null } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.inspectionDate !== undefined ? { inspectionDate: inspectionDate ?? new Date() } : {}),
          ...(body.summary !== undefined ? { summary: body.summary ?? "" } : {}),
          ...(body.overallCondition !== undefined ? { overallCondition: body.overallCondition ?? "GOOD" } : {}),
          ...(body.recommendations !== undefined ? { recommendations: body.recommendations ?? "" } : {}),
        },
        include: detailInclude,
      });
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_UPDATED",
      resourceType: "InspectionReport",
      resourceId: id,
      metadata: { code: report.code, fields: Object.keys(body) },
    });

    return ok(updated);
  },
  PERMISSIONS.irms_manage
);

/** DELETE: only while DRAFT. */
export const DELETE = withId(
  async (id, { req, user }) => {
    const report = await db.inspectionReport.findUnique({ where: { id } });
    if (!report) throw Errors.notFound("Inspection report not found.");
    if (report.status !== "DRAFT") {
      throw Errors.invalidTransition("Only draft reports can be deleted.");
    }
    await db.inspectionReport.delete({ where: { id } });
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_DELETED",
      resourceType: "InspectionReport",
      resourceId: id,
      metadata: { code: report.code, title: report.title },
    });
    return ok({ deleted: true, id });
  },
  PERMISSIONS.irms_manage
);
