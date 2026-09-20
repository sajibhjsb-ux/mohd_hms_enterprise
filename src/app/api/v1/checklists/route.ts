// MOHD.HMS ENTERPRISE — Checklist instances (AI checklist spec §50/§52).
// GET /api/v1/checklists — list instances (staff full; customers scoped to own + sanitized).
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";

const LIST_INCLUDE = {
  workOrder: { select: { id: true, code: true, title: true, status: true } },
  template: { select: { id: true, name: true, version: true } },
} as const;

export const GET = handler(
  async ({ req, user }) => {
    const q = listQuery(req);
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    const sp = new URL(req.url).searchParams;
    const sourceType = (sp.get("sourceType") ?? "").trim();
    const sourceId = (sp.get("sourceId") ?? "").trim();
    const workOrderId = (sp.get("workOrderId") ?? "").trim();
    if (sourceType) where.sourceType = sourceType;
    if (sourceId) where.sourceId = sourceId;
    if (workOrderId) where.workOrderId = workOrderId;
    // §52 — customers see only checklists of their own records, ever.
    if (user.role === "CUSTOMER") where.customerId = user.customerId;
    if (q.search) where.OR = [{ code: { contains: q.search } }, { title: { contains: q.search } }];

    const [total, rows] = await Promise.all([
      db.checklistInstance.count({ where }),
      db.checklistInstance.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: q.skip,
        take: q.take,
      }),
    ]);

    // §52 — strip internals from customer rows (no AI metadata, no approval internals).
    const data = rows.map((r) => {
      if (user.role === "CUSTOMER") {
        return {
          id: r.id, code: r.code, title: r.title, sourceType: r.sourceType, status: r.status,
          version: r.version, createdAt: r.createdAt,
          workOrder: r.workOrder ? { id: r.workOrder.id, code: r.workOrder.code, title: r.workOrder.title, status: r.workOrder.status } : null,
        };
      }
      return r;
    });
    return okList(data, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.checklist_view }
);
