import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

/**
 * 12. GET /api/v1/irms/calendar?from&to (STAFF_READ) — required from/to
 * (YYYY-MM-DD), span capped at 62 days.
 */
export const GET = handler(
  async ({ req }) => {
    const sp = new URL(req.url).searchParams;
    const fromRaw = (sp.get("from") ?? "").trim();
    const toRaw = (sp.get("to") ?? "").trim();
    if (!fromRaw || !toRaw) throw Errors.badRequest("from and to (YYYY-MM-DD) are required.");
    const from = new Date(`${fromRaw}T00:00:00`);
    const to = new Date(`${toRaw}T23:59:59.999`);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw Errors.badRequest("from/to must be YYYY-MM-DD.");
    if (from > to) throw Errors.badRequest("from must be before to.");
    if (to.getTime() - from.getTime() > 62 * 24 * 3600 * 1000) {
      throw Errors.badRequest("Calendar range is limited to 62 days.");
    }

    const items = await db.inspectionReport.findMany({
      where: { inspectionDate: { gte: from, lte: to } },
      orderBy: { inspectionDate: "asc" },
      select: {
        id: true,
        code: true,
        title: true,
        status: true,
        priority: true,
        inspectionDate: true,
        project: { select: { name: true } },
        inspector: { select: { user: { select: { name: true } } } },
      },
    });

    return okList(
      items.map((r) => ({
        id: r.id,
        code: r.code,
        title: r.title,
        status: r.status,
        priority: r.priority,
        inspectionDate: r.inspectionDate,
        project: r.project.name,
        inspector: r.inspector?.user.name ?? null,
      }))
    );
  },
  { permission: PERMISSIONS.irms_read }
);
