// MOHD.HMS ENTERPRISE — PM compliance & performance report (PM §55–§57).
// GET /api/v1/pm/reports?windowDays=90 (7..365, default 90).
// Everything is aggregated live from the database: compliance via the ONE
// centralized computePmMetrics formula, plus overdue rows, technician
// performance, PM cost roll-ups and finding statistics.

import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { computePmMetrics, daysOverdue } from "@/lib/hms/pm/schedule";
import { addDays } from "date-fns";

const OPEN_STATUSES = ["SCHEDULED", "OVERDUE", "IN_PROGRESS"];

export const GET = handler(
  async ({ req }) => {
    const sp = new URL(req.url).searchParams;
    const raw = Number.parseInt(sp.get("windowDays") ?? "90", 10);
    if (!Number.isFinite(raw) || raw < 7 || raw > 365) {
      throw Errors.badRequest("windowDays must be an integer between 7 and 365.");
    }
    const now = new Date();
    const windowStart = addDays(now, -raw);

    const [graceSetting, tasks] = await Promise.all([
      db.setting.findUnique({ where: { key: "automation.pm_grace_days" } }),
      db.pmTask.findMany({
        where: { dueDate: { gte: windowStart, lte: now } },
        include: {
          plan: { select: { name: true, code: true } },
          equipment: { select: { name: true, assetTag: true, customer: { select: { companyName: true } } } },
          technician: { select: { user: { select: { name: true } } } },
          workOrder: { select: { id: true, code: true } },
        },
      }),
    ]);
    const parsedGrace = Number.parseInt(graceSetting?.value ?? "", 10);
    const graceDays = Number.isFinite(parsedGrace) ? parsedGrace : 0;

    // §56 — the single centralized compliance calculation.
    const metrics = computePmMetrics(tasks, { windowDays: raw, graceDays, now });

    // Overdue exposure — OVERDUE rows plus open tasks that slipped past due.
    const overdue = tasks
      .filter((t) => t.status === "OVERDUE" || ((t.status === "SCHEDULED" || t.status === "IN_PROGRESS") && t.dueDate.getTime() < now.getTime()))
      .map((t) => ({
        id: t.id,
        code: t.code,
        dueDate: t.dueDate,
        daysOverdue: daysOverdue(t.dueDate, now),
        priority: t.priority,
        status: t.status,
        equipmentName: t.equipment.name,
        equipmentAssetTag: t.equipment.assetTag,
        customerName: t.equipment.customer?.companyName ?? null,
        technicianName: t.technician?.user?.name ?? null,
        planName: t.plan.name,
      }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue)
      .slice(0, 100);

    // Checklist completion per work order (one grouped pass, §41 efficiency).
    const completedWithWoIds = [...new Set(tasks.filter((t) => t.status === "COMPLETED" && t.workOrderId).map((t) => t.workOrderId as string))];
    const [totalCounts, doneCounts] = await Promise.all([
      db.workOrderChecklistItem.groupBy({ by: ["workOrderId"], where: { workOrderId: { in: completedWithWoIds } }, _count: { _all: true } }),
      db.workOrderChecklistItem.groupBy({ by: ["workOrderId"], where: { workOrderId: { in: completedWithWoIds }, done: true }, _count: { _all: true } }),
    ]);
    const totalCountById = new Map(totalCounts.map((g) => [g.workOrderId, g._count._all]));
    const doneCountById = new Map(doneCounts.map((g) => [g.workOrderId, g._count._all]));
    const fullyDoneWoIds = new Set(
      completedWithWoIds.filter((id) => (doneCountById.get(id) ?? 0) > 0 && doneCountById.get(id) === totalCountById.get(id))
    );

    // Technician performance (open + closed occurrences in window).
    type TechAgg = {
      technicianId: string; name: string; assigned: number; completed: number; overdue: number; failed: number;
      completionHours: number[]; completedWithWo: number; fullyDoneWo: number;
    };
    const byTech = new Map<string, TechAgg>();
    for (const t of tasks) {
      if (!t.technicianId) continue;
      const agg = byTech.get(t.technicianId) ?? {
        technicianId: t.technicianId, name: t.technician?.user?.name ?? "",
        assigned: 0, completed: 0, overdue: 0, failed: 0, completionHours: [], completedWithWo: 0, fullyDoneWo: 0,
      };
      agg.assigned += 1;
      if (t.status === "COMPLETED") {
        agg.completed += 1;
        if (t.completedAt) {
          const hours = (t.completedAt.getTime() - t.dueDate.getTime()) / 3_600_000;
          if (hours > 0) agg.completionHours.push(hours);
        }
        if (t.workOrderId) {
          agg.completedWithWo += 1;
          if (fullyDoneWoIds.has(t.workOrderId)) agg.fullyDoneWo += 1;
        }
      } else if (t.status === "OVERDUE") {
        agg.overdue += 1;
      } else if (t.status === "FAILED") {
        agg.failed += 1;
      }
      byTech.set(t.technicianId, agg);
    }
    const technicians = [...byTech.values()].map((a) => ({
      technicianId: a.technicianId,
      name: a.name,
      assigned: a.assigned,
      completed: a.completed,
      overdue: a.overdue,
      failed: a.failed,
      avgCompletionHours: a.completionHours.length
        ? Math.round((a.completionHours.reduce((s, h) => s + h, 0) / a.completionHours.length) * 10) / 10
        : null,
      checklistRate: a.completedWithWo > 0 ? Math.round((a.fullyDoneWo / a.completedWithWo) * 100) / 100 : null,
    }));

    // PM cost roll-ups (completed PM work orders in the window).
    const woCostWhere = {
      sourceType: "PM",
      status: "COMPLETED",
      completedAt: { gte: windowStart, lte: now },
    } as const;
    const [assetGroups, customerGroups] = await Promise.all([
      db.workOrder.groupBy({
        by: ["equipmentId"],
        where: { ...woCostWhere, equipmentId: { not: null } },
        _count: { _all: true },
        _sum: { labourTotalCents: true, materialsTotalCents: true, totalCents: true },
      }),
      db.workOrder.groupBy({
        by: ["customerId"],
        where: woCostWhere,
        _count: { _all: true },
        _sum: { labourTotalCents: true, materialsTotalCents: true, totalCents: true },
      }),
    ]);

    const equipmentIds = assetGroups.map((g) => g.equipmentId as string);
    const equipmentRows = equipmentIds.length
      ? await db.equipment.findMany({ where: { id: { in: equipmentIds } }, select: { id: true, name: true, assetTag: true } })
      : [];
    const eqById = new Map(equipmentRows.map((e) => [e.id, e]));
    const costsByAsset = assetGroups
      .map((g) => ({
        equipmentId: g.equipmentId,
        equipmentName: eqById.get(g.equipmentId as string)?.name ?? "",
        assetTag: eqById.get(g.equipmentId as string)?.assetTag ?? "",
        workOrders: g._count._all,
        labourCents: g._sum.labourTotalCents ?? 0,
        materialsCents: g._sum.materialsTotalCents ?? 0,
        totalCents: g._sum.totalCents ?? 0,
      }))
      .sort((a, b) => b.totalCents - a.totalCents);

    const customerIds = customerGroups.map((g) => g.customerId);
    const customerNameRows = customerIds.length
      ? await db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, companyName: true } })
      : [];
    const custById = new Map(customerNameRows.map((c) => [c.id, c.companyName]));
    const costsByCustomer = customerGroups
      .map((g) => ({
        customerId: g.customerId,
        customerName: custById.get(g.customerId) ?? "",
        workOrders: g._count._all,
        labourCents: g._sum.labourTotalCents ?? 0,
        materialsCents: g._sum.materialsTotalCents ?? 0,
        totalCents: g._sum.totalCents ?? 0,
      }))
      .sort((a, b) => b.totalCents - a.totalCents);

    // Findings statistics in window.
    const findingGroups = await db.pmFinding.groupBy({
      by: ["severity"],
      where: { createdAt: { gte: windowStart, lte: now } },
      _count: { _all: true },
    });
    const findingsSummary = findingGroups.map((g) => ({ severity: g.severity, count: g._count._all }));

    // Next occurrences — same shape as the dashboard upcoming list.
    const upcomingRows = await db.pmTask.findMany({
      where: { status: { in: OPEN_STATUSES }, dueDate: { gte: now } },
      orderBy: { dueDate: "asc" },
      take: 10,
      include: {
        plan: { select: { name: true, code: true } },
        equipment: { select: { name: true, assetTag: true, criticality: true } },
        technician: { select: { user: { select: { name: true } } } },
      },
    });

    return ok({
      windowDays: raw,
      generatedAt: now.toISOString(),
      compliance: metrics,
      overdue,
      technicians,
      costsByAsset,
      costsByCustomer,
      findingsSummary,
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
    });
  },
  { permission: PERMISSIONS.pm_report }
);
