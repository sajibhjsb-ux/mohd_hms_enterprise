import { db } from "@/lib/db";
import { handler, okList } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

const PORTAL_STATUSES = ["CLIENT_REVIEW", "APPROVED", "ARCHIVED"] as const;

/**
 * 14a. GET /api/v1/irms/portal (PORTAL) — customer-scoped, customerVisible
 * reports in CLIENT_REVIEW/APPROVED/ARCHIVED. List shape without internal fields.
 */
export const GET = handler(
  async ({ user }) => {
    const where = {
      project: { customerId: user.customerId ?? "__none__" },
      customerVisible: true,
      status: { in: [...PORTAL_STATUSES] },
    };

    const items = await db.inspectionReport.findMany({
      where,
      orderBy: { inspectionDate: "desc" },
      include: {
        project: { select: { id: true, code: true, name: true, siteLocation: true } },
        equipment: { select: { id: true, name: true, assetTag: true } },
        inspector: { select: { user: { select: { name: true } } } },
        _count: { select: { photos: true, findings: true, signatures: true } },
      },
    });

    return okList(
      items.map((r) => ({
        id: r.id,
        code: r.code,
        title: r.title,
        type: r.type,
        priority: r.priority,
        status: r.status,
        inspectionDate: r.inspectionDate,
        overallCondition: r.overallCondition,
        summary: r.summary,
        completionPercent: r.completionPercent,
        revision: r.revision,
        approvedAt: r.approvedAt,
        createdAt: r.createdAt,
        project: r.project,
        equipment: r.equipment,
        inspectorName: r.inspector?.user.name ?? null,
        photosCount: r._count.photos,
        findingsCount: r._count.findings,
        signaturesCount: r._count.signatures,
      }))
    );
  },
  { permission: PERMISSIONS.irms_portal }
);
