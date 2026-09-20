// MOHD.HMS ENTERPRISE — PM dashboard KPIs (PM §56).
// Every number is computed live from the database — no mocks, no cached guesses.
// Compliance/completion use the ONE centralized computePmMetrics formula.

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { computePmMetrics } from "@/lib/hms/pm/schedule";
import { startOfDay, endOfDay, addDays, startOfMonth, endOfMonth } from "date-fns";

const OPEN_STATUSES = ["SCHEDULED", "OVERDUE", "IN_PROGRESS"];

export const GET = handler(
  async ({ user }) => {
    const now = new Date();
    // §44 defense-in-depth — customers are already blocked by pm.read, but if
    // they ever gain read access every number must scope to their equipment.
    const eqScope = user.role === "CUSTOMER" ? { customerId: user.customerId ?? "__none__" } : null;
    const openTaskWhere = {
      status: { in: OPEN_STATUSES },
      ...(eqScope ? { equipment: { is: eqScope } } : {}),
    };
    const anyTaskWhere = eqScope ? { equipment: { is: eqScope } } : {};

    const [
      dueToday,
      dueThisWeek,
      dueThisMonth,
      overdue,
      scheduled,
      inProgress,
      completedThisMonth,
      failed,
      highRiskAssets,
      assetsWithoutPlan,
      openPmWorkOrders,
    ] = await Promise.all([
      db.pmTask.count({ where: { ...openTaskWhere, dueDate: { gte: startOfDay(now), lte: endOfDay(now) } } }),
      db.pmTask.count({ where: { ...openTaskWhere, dueDate: { gte: startOfDay(now), lte: endOfDay(addDays(now, 7)) } } }),
      db.pmTask.count({ where: { ...openTaskWhere, dueDate: { gte: startOfDay(now), lte: endOfDay(addDays(now, 31)) } } }),
      db.pmTask.count({ where: { ...anyTaskWhere, status: "OVERDUE" } }),
      db.pmTask.count({ where: { ...anyTaskWhere, status: "SCHEDULED" } }),
      db.pmTask.count({ where: { ...anyTaskWhere, status: "IN_PROGRESS" } }),
      db.pmTask.count({ where: { ...anyTaskWhere, status: "COMPLETED", completedAt: { gte: startOfMonth(now), lte: endOfMonth(now) } } }),
      db.pmTask.count({ where: { ...anyTaskWhere, status: "FAILED", dueDate: { gte: addDays(now, -90) } } }),
      db.equipment.count({
        where: {
          ...(eqScope ?? {}),
          criticality: { in: ["HIGH", "CRITICAL"] },
          status: { not: "RETIRED" },
          pmTasks: { some: { status: { in: OPEN_STATUSES } } },
        },
      }),
      db.equipment.count({ where: { ...(eqScope ?? {}), status: { not: "RETIRED" }, pmPlans: { none: {} } } }),
      db.workOrder.count({
        where: {
          ...(eqScope ? { customerId: eqScope.customerId } : {}),
          sourceType: "PM",
          status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"] },
        },
      }),
    ]);

    // §56 compliance window — last 90 days, grace days from automation settings.
    const [metricTasks, graceSetting] = await Promise.all([
      db.pmTask.findMany({
        where: { dueDate: { gte: addDays(now, -90), lte: now }, ...(eqScope ? { equipment: { is: eqScope } } : {}) },
        select: { status: true, dueDate: true, completedAt: true },
      }),
      db.setting.findUnique({ where: { key: "automation.pm_grace_days" } }),
    ]);
    const parsedGrace = Number.parseInt(graceSetting?.value ?? "", 10);
    const metrics = computePmMetrics(metricTasks, { windowDays: 90, graceDays: Number.isFinite(parsedGrace) ? parsedGrace : 0, now });

    const upcomingRows = await db.pmTask.findMany({
      where: openTaskWhere,
      orderBy: { dueDate: "asc" },
      take: 6,
      include: {
        plan: { select: { name: true, code: true } },
        equipment: { select: { name: true, assetTag: true, criticality: true } },
        technician: { select: { user: { select: { name: true } } } },
      },
    });

    return ok({
      kpis: {
        dueToday, dueThisWeek, dueThisMonth, overdue, scheduled, inProgress,
        completedThisMonth, failed, highRiskAssets, assetsWithoutPlan, openPmWorkOrders,
      },
      compliancePct: metrics.compliancePct,
      completionPct: metrics.completionPct,
      compliance: {
        windowDays: metrics.windowDays,
        dueOccurrences: metrics.dueOccurrences,
        completedOnTime: metrics.completedOnTime,
        excluded: metrics.excluded,
        graceDays: metrics.graceDays,
      },
      upcoming: upcomingRows.map((t) => ({
        id: t.id,
        code: t.code,
        dueDate: t.dueDate,
        status: t.status,
        priority: t.priority,
        plan: { name: t.plan.name, code: t.plan.code },
        equipment: { name: t.equipment.name, assetTag: t.equipment.assetTag, criticality: t.equipment.criticality },
        technicianName: t.technician?.user?.name ?? null,
      })),
      generatedAt: now.toISOString(),
    });
  },
  { permission: PERMISSIONS.pm_read }
);
