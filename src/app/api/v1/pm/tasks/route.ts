import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";

const taskInclude = {
  plan: { select: { id: true, name: true, code: true } },
  equipment: { select: { id: true, name: true, assetTag: true } },
  technician: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
} as const;

/**
 * PM task list. Auto-flags SCHEDULED tasks past their due date as OVERDUE
 * before querying, so the overdue state is always accurate.
 */
export const GET = handler(
  async ({ req, user }) => {
    // Rollover: SCHEDULED + past due → OVERDUE
    await db.pmTask.updateMany({
      where: { status: "SCHEDULED", dueDate: { lt: new Date() } },
      data: { status: "OVERDUE" },
    });

    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const status = (sp.get("status") ?? "").trim();
    const overdue = (sp.get("overdue") ?? "").trim();
    const technicianId = (sp.get("technicianId") ?? "").trim();
    const mine = (sp.get("mine") ?? "").trim();
    const planId = (sp.get("planId") ?? "").trim();

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (planId) where.planId = planId;
    if (technicianId) where.technicianId = technicianId;
    if (overdue === "1") {
      where.dueDate = { lt: new Date() };
      where.status = { in: ["SCHEDULED", "IN_PROGRESS"] };
    }
    if (mine === "1") {
      const profile = await db.technicianProfile.findUnique({ where: { userId: user.id } });
      where.technicianId = profile?.id ?? "__none__";
    }
    if (q.search) {
      where.OR = [
        { code: { contains: q.search } },
        { plan: { is: { name: { contains: q.search } } } },
        { equipment: { is: { name: { contains: q.search } } } },
        { equipment: { is: { assetTag: { contains: q.search } } } },
      ];
    }

    const dir = q.dir === "asc" ? ("asc" as const) : ("desc" as const);
    const [items, total] = await Promise.all([
      db.pmTask.findMany({
        where,
        include: taskInclude,
        orderBy: { dueDate: dir },
        skip: q.skip,
        take: q.take,
      }),
      db.pmTask.count({ where }),
    ]);

    return okList(items, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.pm_read }
);
