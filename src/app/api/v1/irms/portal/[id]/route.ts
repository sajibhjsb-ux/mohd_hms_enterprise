import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { canonicalPhotoOrder } from "@/lib/hms/irms/storage";

const PORTAL_STATUSES = ["CLIENT_REVIEW", "APPROVED", "ARCHIVED"] as const;

/**
 * 14b. GET /api/v1/irms/portal/[id] (PORTAL) — customer detail. Server-side
 * scoping: own customer + customerVisible + visible status, else 404 (existence
 * hidden). Internal fields are stripped (notes, rootCause, safetyNotes, exif,
 * workOrderId / jobOrderNo / submittedById etc.).
 */
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return handler(
    async ({ user }) => {
      const report = await db.inspectionReport.findUnique({
        where: { id },
        include: {
          project: { select: { id: true, code: true, name: true, siteLocation: true, customerId: true } },
          equipment: { select: { id: true, name: true, assetTag: true } },
          inspector: { select: { user: { select: { name: true } } } },
          findings: { orderBy: { id: "asc" as const }, select: { id: true, finding: true, severity: true, recommendation: true } },
          photos: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
          signatures: { orderBy: { signedAt: "desc" as const }, select: { id: true, role: true, name: true, signedAt: true, revision: true } },
        },
      });
      if (
        !report ||
        report.project.customerId !== user.customerId ||
        !report.customerVisible ||
        !(PORTAL_STATUSES as readonly string[]).includes(report.status)
      ) {
        throw Errors.notFound("Inspection report not found.");
      }

      return NextResponse.json({
        ok: true,
        data: {
          id: report.id,
          code: report.code,
          title: report.title,
          type: report.type,
          priority: report.priority,
          status: report.status,
          inspectionDate: report.inspectionDate,
          overallCondition: report.overallCondition,
          summary: report.summary,
          recommendations: report.recommendations,
          building: report.building,
          floor: report.floor,
          room: report.room,
          taskDescription: report.taskDescription,
          scope: report.scope,
          correctiveActions: report.correctiveActions,
          materials: report.materials,
          labourHours: report.labourHours,
          completionPercent: report.completionPercent,
          revision: report.revision,
          clientComment: report.clientComment,
          approvedAt: report.approvedAt,
          archivedAt: report.archivedAt,
          createdAt: report.createdAt,
          project: report.project,
          equipment: report.equipment,
          inspectorName: report.inspector?.user.name ?? null,
          findings: report.findings,
          photos: canonicalPhotoOrder(report.photos).map((p) => ({
            id: p.id,
            category: p.category,
            photoNo: p.photoNo,
            sortOrder: p.sortOrder,
            caption: p.caption,
            width: p.width,
            height: p.height,
            urls: {
              thumb: `/api/v1/irms/photos/${p.id}/file?variant=thumb`,
              display: `/api/v1/irms/photos/${p.id}/file?variant=display`,
            },
          })),
          signatures: report.signatures.map((s) => ({
            id: s.id,
            role: s.role,
            name: s.name,
            signedAt: s.signedAt,
            revision: s.revision,
            url: `/api/v1/irms/signatures/${s.id}/file`,
          })),
        },
      });
    },
    { permission: PERMISSIONS.irms_portal }
  )(req);
};
