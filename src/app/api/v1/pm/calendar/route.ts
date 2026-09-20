// MOHD.HMS ENTERPRISE — PM occurrence calendar (PM §26).
// GET /api/v1/pm/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD (max 62-day span).
// Occurrences grouped by ISO day for the month/calendar grid surface.

import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { startOfDay, endOfDay } from "date-fns";

const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 62;

export const GET = handler(
  async ({ req, user }) => {
    const sp = new URL(req.url).searchParams;
    const fromStr = (sp.get("from") ?? "").trim();
    const toStr = (sp.get("to") ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
      throw Errors.badRequest("Query parameters from and to are required as YYYY-MM-DD dates.");
    }
    const from = new Date(`${fromStr}T00:00:00`);
    const to = new Date(`${toStr}T00:00:00`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw Errors.badRequest("from/to is not a valid calendar date.");
    }
    if (to.getTime() < from.getTime()) throw Errors.badRequest("to must be on or after from.");
    if ((to.getTime() - from.getTime()) / DAY_MS > MAX_SPAN_DAYS) {
      throw Errors.badRequest(`Date range is limited to ${MAX_SPAN_DAYS} days.`);
    }

    const where: Record<string, unknown> = { dueDate: { gte: startOfDay(from), lte: endOfDay(to) } };
    // §44 — customers may only ever see PM for their own equipment.
    if (user.role === "CUSTOMER") {
      where.equipment = { is: { customerId: user.customerId ?? "__none__" } };
    }

    const tasks = await db.pmTask.findMany({
      where,
      orderBy: { dueDate: "asc" },
      include: {
        plan: { select: { name: true, code: true } },
        equipment: { select: { name: true, assetTag: true } },
        technician: { select: { user: { select: { name: true } } } },
      },
    });

    const byDay = new Map<string, {
      id: string; code: string; dueDate: Date; status: string; priority: string;
      planName: string; planCode: string; equipmentName: string; equipmentAssetTag: string; technicianName: string | null;
    }[]>();
    for (const t of tasks) {
      const day = t.dueDate.toISOString().slice(0, 10);
      const items = byDay.get(day) ?? [];
      items.push({
        id: t.id, code: t.code, dueDate: t.dueDate, status: t.status, priority: t.priority,
        planName: t.plan.name, planCode: t.plan.code,
        equipmentName: t.equipment.name, equipmentAssetTag: t.equipment.assetTag,
        technicianName: t.technician?.user?.name ?? null,
      });
      byDay.set(day, items);
    }

    const data = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, items]) => ({ date, items }));
    return ok(data);
  },
  { permission: PERMISSIONS.pm_read }
);
