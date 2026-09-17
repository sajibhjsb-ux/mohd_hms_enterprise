import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

function dayRange(dateStr: string): { start: Date; end: Date } {
  const [y, m, d] = dateStr.split("-").map((n) => parseInt(n, 10));
  const start = new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
  const end = new Date(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999);
  if (isNaN(start.getTime())) throw Errors.badRequest("Date is invalid. Use YYYY-MM-DD.");
  return { start, end };
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Attendance register: a single day (?date=) or a range (?from&to). */
export const GET = handler(
  async ({ req }) => {
    const sp = new URL(req.url).searchParams;
    const from = (sp.get("from") ?? "").trim();
    const to = (sp.get("to") ?? "").trim();
    const employeeId = (sp.get("employeeId") ?? "").trim();

    const where: Record<string, unknown> = {};
    if (from && to) {
      where.date = { gte: dayRange(from).start, lte: dayRange(to).end };
    } else if (from) {
      where.date = { gte: dayRange(from).start, lte: dayRange(from).end };
    } else {
      const target = (sp.get("date") ?? "").trim() || isoDate(new Date());
      const { start, end } = dayRange(target);
      where.date = { gte: start, lte: end };
    }
    if (employeeId) where.employeeId = employeeId;

    const items = await db.attendance.findMany({
      where,
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true, position: true } },
      },
      orderBy: [{ date: "desc" }, { employee: { firstName: "asc" } }],
    });

    return okList(items);
  },
  { permission: PERMISSIONS.hr_read }
);

const ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "LEAVE", "HALF_DAY"] as const;

const markSchema = z.object({
  employeeId: z.string().min(1, "Employee is required."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD."),
  status: z.enum(ATTENDANCE_STATUSES),
  checkIn: z.string().nullish(),
  checkOut: z.string().nullish(),
  notes: z.string().max(500).nullish(),
});

/** Mark attendance (idempotent per employee+day): upsert by unique(employeeId, date). */
export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, markSchema);

    const employee = await db.employee.findUnique({ where: { id: body.employeeId } });
    if (!employee) throw Errors.badRequest("Employee does not exist.");

    const { start, end } = dayRange(body.date);
    const parseTime = (s: string | null | undefined, day: Date): Date | null => {
      if (!s) return null;
      // Accept "HH:MM" (combined with the marked day) or a full ISO timestamp
      if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) {
        const [h, m] = s.split(":").map((n) => parseInt(n, 10));
        const d = new Date(day);
        d.setHours(h, m, 0, 0);
        return d;
      }
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    };

    const existing = await db.attendance.findFirst({ where: { employeeId: body.employeeId, date: { gte: start, lte: end } } });

    const data = {
      status: body.status,
      checkIn: parseTime(body.checkIn, start),
      checkOut: parseTime(body.checkOut, start),
      notes: body.notes ?? "",
    };

    const record = existing
      ? await db.attendance.update({ where: { id: existing.id }, data })
      : await db.attendance.create({ data: { employeeId: body.employeeId, date: start, ...data } });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "ATTENDANCE_MARKED",
      resourceType: "Attendance",
      resourceId: record.id,
      metadata: {
        employee: `${employee.firstName} ${employee.lastName}`,
        date: body.date,
        status: body.status,
        updated: Boolean(existing),
      },
    });

    return ok(record, existing ? 200 : 201);
  },
  { permission: PERMISSIONS.hr_manage }
);
