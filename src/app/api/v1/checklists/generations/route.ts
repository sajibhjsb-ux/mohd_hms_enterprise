// MOHD.HMS ENTERPRISE — AI generation log (spec §38/§80).
// GET /api/v1/checklists/generations — safe metadata only (no prompts, no secrets).
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const where: Record<string, unknown> = {};
    const sp = new URL(req.url).searchParams;
    const sourceType = (sp.get("sourceType") ?? "").trim();
    const status = (sp.get("status") ?? "").trim();
    if (sourceType) where.sourceType = sourceType;
    if (status) where.status = status;
    const [total, rows] = await Promise.all([
      db.checklistAiGeneration.count({ where }),
      db.checklistAiGeneration.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: q.skip,
        take: q.take,
        select: {
          id: true, sourceType: true, sourceId: true, workOrderId: true, templateId: true,
          templateVersion: true, promptVersion: true, provider: true, model: true, status: true,
          itemCount: true, error: true, contextSummary: true, instanceId: true, createdAt: true,
        },
      }),
    ]);
    return okList(rows, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.checklist_template_manage }
);
