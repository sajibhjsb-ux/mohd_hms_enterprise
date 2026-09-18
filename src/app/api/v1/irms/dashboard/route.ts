import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { overdueWhere, startOfToday } from "@/lib/hms/irms/storage";

/**
 * 10. GET /api/v1/irms/dashboard (STAFF_READ) — KPIs + recent + byStatus.
 * Overdue predicate (§35): inspectionDate < today(start of day) AND status open.
 */
export const GET = handler(
  async ({ user }) => {
    const [grouped, overdue, activeProjects, photos, mine, nonDraft] = await Promise.all([
      db.inspectionReport.groupBy({ by: ["status"], _count: { _all: true } }),
      db.inspectionReport.count({ where: overdueWhere() }),
      db.irmsProject.count({ where: { status: "ACTIVE" } }),
      db.inspectionPhoto.count(),
      db.inspectionReport.count({ where: { inspector: { is: { userId: user.id } } } }),
      db.inspectionReport.aggregate({
        where: { status: { notIn: ["DRAFT", "ARCHIVED"] } },
        _avg: { completionPercent: true },
      }),
    ]);

    const byStatus = new Map(grouped.map((g) => [g.status, g._count._all]));
    const count = (s: string) => byStatus.get(s) ?? 0;

    const recent = await db.inspectionReport.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        project: { select: { id: true, code: true, name: true, customerId: true, customer: { select: { companyName: true } } } },
        equipment: { select: { id: true, name: true, assetTag: true } },
        inspector: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
        workOrder: { select: { id: true, code: true } },
        _count: { select: { photos: true, findings: true } },
      },
    });

    return ok({
      kpis: {
        total: grouped.reduce((s, g) => s + g._count._all, 0),
        drafts: count("DRAFT"),
        submitted: count("SUBMITTED"),
        inReview: count("IN_REVIEW"),
        managerApproval: count("MANAGER_APPROVAL"),
        clientReview: count("CLIENT_REVIEW"),
        approved: count("APPROVED"),
        rejected: count("REJECTED"),
        archived: count("ARCHIVED"),
        overdue,
        activeProjects,
        avgCompletion: Math.round(nonDraft._avg.completionPercent ?? 0),
        photos,
        mine,
      },
      recent: recent.map((r) => ({ ...r, photosCount: r._count.photos, findingsCount: r._count.findings })),
      byStatus: [...byStatus.entries()].map(([status, c]) => ({ status, count: c })),
      generatedAt: startOfToday().toISOString(),
    });
  },
  { permission: PERMISSIONS.irms_read }
);
