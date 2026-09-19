import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

/**
 * 11. GET /api/v1/irms/analytics?from&to (STAFF_READ; default last 12 months).
 * Aggregates run on the report createdAt window; avgApprovalHours is the mean
 * of (approvedAt − submittedAt) across reports approved in the window.
 */
export const GET = handler(
  async ({ req }) => {
    const sp = new URL(req.url).searchParams;
    const now = new Date();
    const defFrom = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const from = sp.get("from") ? new Date(`${sp.get("from")}T00:00:00`) : defFrom;
    const to = sp.get("to") ? new Date(`${sp.get("to")}T23:59:59.999`) : now;
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw Errors.badRequest("from/to must be YYYY-MM-DD.");
    if (from > to) throw Errors.badRequest("from must be before to.");
    const window = { createdAt: { gte: from, lte: to } };

    const [byStatusG, byTypeG, byProjectG, byInspectorG, severityG, createdRows, approvedReports] = await Promise.all([
      db.inspectionReport.groupBy({ by: ["status"], where: window, _count: { _all: true } }),
      db.inspectionReport.groupBy({ by: ["type"], where: window, _count: { _all: true } }),
      db.inspectionReport.groupBy({ by: ["projectId"], where: window, _count: { _all: true }, orderBy: { _count: { projectId: "desc" } }, take: 10 }),
      db.inspectionReport.groupBy({ by: ["inspectorId"], where: window, _count: { _all: true }, orderBy: { _count: { inspectorId: "desc" } }, take: 10 }),
      db.inspectionFinding.groupBy({ by: ["severity"], where: { report: window }, _count: { _all: true } }),
      db.inspectionReport.findMany({ where: window, select: { createdAt: true } }),
      db.inspectionReport.findMany({ where: { ...window, status: { in: ["APPROVED", "ARCHIVED"] }, approvedAt: { not: null }, submittedAt: { not: null } }, select: { approvedAt: true, submittedAt: true } }),
    ]);

    const [projectIds, inspectorIds] = [byProjectG.map((g) => g.projectId), byInspectorG.map((g) => g.inspectorId).filter((v): v is string => !!v)];
    const [projects, inspectors] = await Promise.all([
      db.irmsProject.findMany({ where: { id: { in: projectIds } }, select: { id: true, code: true, name: true } }),
      db.technicianProfile.findMany({ where: { id: { in: inspectorIds } }, select: { id: true, employeeNo: true, user: { select: { name: true } } } }),
    ]);
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));
    const inspectorNames = new Map(inspectors.map((i) => [i.id, i.user.name]));

    // Monthly buckets (YYYY-MM) — created by createdAt, approved by approvedAt.
    const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const monthlyMap = new Map<string, { month: string; created: number; approved: number }>();
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    while (cursor <= to) {
      monthlyMap.set(monthKey(cursor), { month: monthKey(cursor), created: 0, approved: 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    for (const row of createdRows) {
      const k = monthKey(row.createdAt);
      const bucket = monthlyMap.get(k);
      if (bucket) bucket.created += 1;
    }
    for (const r of approvedReports) {
      if (!r.approvedAt) continue;
      const k = monthKey(r.approvedAt);
      const row = monthlyMap.get(k);
      if (row) row.approved += 1;
    }

    const approvalHours = approvedReports
      .filter((r) => r.approvedAt && r.submittedAt)
      .map((r) => (r.approvedAt!.getTime() - r.submittedAt!.getTime()) / 3_600_000);
    const avgApprovalHours = approvalHours.length > 0 ? approvalHours.reduce((s, v) => s + v, 0) / approvalHours.length : null;

    return ok({
      byStatus: byStatusG.map((g) => ({ status: g.status, count: g._count._all })),
      byType: byTypeG.map((g) => ({ type: g.type, count: g._count._all })),
      byProject: byProjectG.map((g) => ({ project: projectNames.get(g.projectId) ?? g.projectId, count: g._count._all })),
      byInspector: byInspectorG.map((g) => ({ inspector: g.inspectorId ? inspectorNames.get(g.inspectorId) ?? "Unassigned" : "Unassigned", count: g._count._all })),
      monthly: [...monthlyMap.values()],
      defectSeverity: severityG.map((g) => ({ severity: g.severity, count: g._count._all })),
      avgApprovalHours,
    });
  },
  { permission: PERMISSIONS.irms_read }
);
