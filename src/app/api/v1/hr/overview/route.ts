import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

function dayStart(offsetDays = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayEnd(offsetDays = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * HR overview: live headcount + attendance KPIs, per-department distribution
 * and a 7-day attendance trend — all computed from the database.
 */
export const GET = handler(
  async () => {
    const todayStart = dayStart(0);
    const todayEnd = dayEnd(0);
    const weekStart = dayStart(-6);

    const [headcount, activeCount, pendingLeaves, todayAttendance, departments, weekAttendance] = await Promise.all([
      db.employee.count(),
      db.employee.count({ where: { status: "ACTIVE" } }),
      db.leaveRequest.count({ where: { status: "PENDING" } }),
      db.attendance.findMany({ where: { date: { gte: todayStart, lte: todayEnd } }, select: { status: true } }),
      db.department.findMany({ include: { _count: { select: { employees: true } } }, orderBy: { name: "asc" } }),
      db.attendance.findMany({
        where: { date: { gte: weekStart, lte: todayEnd } },
        select: { date: true, status: true },
      }),
    ]);

    const countBy = (rows: { status: string }[], status: string) => rows.filter((r) => r.status === status).length;

    const attendance7d: { date: string; present: number; absent: number; leave: number; half: number }[] = [];
    for (let i = -6; i <= 0; i++) {
      const s = dayStart(i);
      const e = dayEnd(i);
      const rows = weekAttendance.filter((a) => a.date >= s && a.date <= e);
      attendance7d.push({
        date: s.toISOString().slice(0, 10),
        present: countBy(rows, "PRESENT"),
        absent: countBy(rows, "ABSENT"),
        leave: countBy(rows, "LEAVE"),
        half: countBy(rows, "HALF_DAY"),
      });
    }

    return ok({
      headcount,
      activeCount,
      onLeaveToday: countBy(todayAttendance, "LEAVE"),
      presentToday: countBy(todayAttendance, "PRESENT"),
      halfDayToday: countBy(todayAttendance, "HALF_DAY"),
      absentToday: countBy(todayAttendance, "ABSENT"),
      pendingLeaves,
      departments: departments.map((d) => ({ id: d.id, name: d.name, description: d.description, count: d._count.employees })),
      attendance7d,
    });
  },
  { permission: PERMISSIONS.hr_read }
);
