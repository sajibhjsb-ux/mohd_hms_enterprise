import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { startOfDay, endOfDay, addDays } from "date-fns";

const taskInclude = {
  plan: { select: { id: true, name: true, code: true, planType: true, priority: true } },
  equipment: { select: { id: true, name: true, assetTag: true, criticality: true, customer: { select: { id: true, companyName: true } }, location: { select: { id: true, name: true } } } },
  technician: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
  workOrder: { select: { id: true, code: true, status: true, priority: true } },
} as const;

/**
 * PM occurrence list (§26/§49/§50). Auto-flags SCHEDULED tasks past their due
 * date as OVERDUE before querying (§32 — overdue is never hidden by moving dates).
 * Filters: status, due=today|week|month, overdue=1, technicianId, mine, planId,
 * priority, search. CUSTOMER role is scoped to own equipment (§44).
 */
export const GET = handler(
  async ({ req, user }) => {
    // Rollover: SCHEDULED + due before today → OVERDUE (§32). A task due today
    // is NOT overdue until the day has passed.
    await db.pmTask.updateMany({
      where: { status: "SCHEDULED", dueDate: { lt: startOfDay(new Date()) } },
      data: { status: "OVERDUE" },
    });

    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const status = (sp.get("status") ?? "").trim();
    const overdue = (sp.get("overdue") ?? "").trim();
    const technicianId = (sp.get("technicianId") ?? "").trim();
    const mine = (sp.get("mine") ?? "").trim();
    const planId = (sp.get("planId") ?? "").trim();
    const due = (sp.get("due") ?? "").trim();
    const priority = (sp.get("priority") ?? "").trim();

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (planId) where.planId = planId;
    if (priority) where.priority = priority;
    if (technicianId) where.technicianId = technicianId;
    if (overdue === "1") {
      // §32 — anything that slipped: already-rolled-over OVERDUE rows plus open
      // rows due before today (SCHEDULED/IN_PROGRESS).
      where.dueDate = { lt: startOfDay(new Date()) };
      where.status = { in: ["OVERDUE", "SCHEDULED", "IN_PROGRESS"] };
    }
    // §4 KPI drill-downs: due=today | week | month (open occurrences only)
    if (due) {
      const now = new Date();
      if (due === "today") {
        where.dueDate = { gte: startOfDay(now), lte: endOfDay(now) };
        where.status = { in: ["SCHEDULED", "OVERDUE", "IN_PROGRESS"] };
      } else if (due === "week") {
        where.dueDate = { gte: startOfDay(now), lte: endOfDay(addDays(now, 7)) };
        where.status = { in: ["SCHEDULED", "OVERDUE", "IN_PROGRESS"] };
      } else if (due === "month") {
        where.dueDate = { gte: startOfDay(now), lte: endOfDay(addDays(now, 31)) };
        where.status = { in: ["SCHEDULED", "OVERDUE", "IN_PROGRESS"] };
      }
    }
    if (mine === "1") {
      const profile = await db.technicianProfile.findUnique({ where: { userId: user.id } });
      where.technicianId = profile?.id ?? "__none__";
    }
    // §44 — customers only ever see PM for their own equipment.
    if (user.role === "CUSTOMER") {
      where.equipment = { is: { customerId: user.customerId ?? "__none__" } };
    }
    if (q.search) {
      where.OR = [
        { code: { contains: q.search } },
        { plan: { is: { name: { contains: q.search } } } },
        { equipment: { is: { name: { contains: q.search } } } },
        { equipment: { is: { assetTag: { contains: q.search } } } },
        { workOrder: { is: { code: { contains: q.search } } } },
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
