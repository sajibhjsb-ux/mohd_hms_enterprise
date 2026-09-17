import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { isStaff } from "@/lib/hms/rbac";

/**
 * Role-based dashboard. All figures are computed live from the database —
 * no hardcoded KPIs anywhere in the product.
 */
export const GET = handler(
  async ({ user }) => {
    const staff = isStaff(user.role);
    const customerId = staff ? undefined : (user.customerId ?? "none");

    const [openComplaints, urgentComplaints, activeWOs, pendingWOs, overduePm, lowStock, equipmentDown, unreadNotifs] = await Promise.all([
      db.complaint.count({ where: { status: { in: ["NEW", "ASSIGNED", "IN_PROGRESS"] }, ...(customerId ? { customerId } : {}) } }),
      db.complaint.count({ where: { priority: "URGENT", status: { in: ["NEW", "ASSIGNED", "IN_PROGRESS"] }, ...(customerId ? { customerId } : {}) } }),
      db.workOrder.count({ where: { status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"] }, ...(customerId ? { customerId } : {}) } }),
      db.workOrder.count({ where: { status: { in: ["PENDING", "ACCEPTED"] }, ...(customerId ? { customerId } : {}) } }),
      db.pmTask.count({ where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] }, dueDate: { lt: new Date() } } }),
      staff ? db.inventoryItem.count({ where: { stockQty: { lte: db.inventoryItem.fields.minStockQty }, status: "ACTIVE" } }) : Promise.resolve(0),
      db.equipment.count({ where: { status: "UNDER_MAINTENANCE", ...(customerId ? { customerId } : {}) } }),
      db.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);

    // Complaints by status (7d trend + all-time)
    const complaintStatusGroups = await db.complaint.groupBy({ by: ["status"], _count: { status: true }, where: customerId ? { customerId } : {} });

    // Complaints last 14 days (daily)
    const since = new Date(Date.now() - 13 * 86400000);
    since.setHours(0, 0, 0, 0);
    const recentComplaints = await db.complaint.findMany({
      where: { createdAt: { gte: since }, ...(customerId ? { customerId } : {}) },
      select: { createdAt: true },
    });
    const daily: { date: string; count: number }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(since.getTime() + i * 86400000);
      const next = new Date(d.getTime() + 86400000);
      daily.push({ date: d.toISOString().slice(0, 10), count: recentComplaints.filter((c) => c.createdAt >= d && c.createdAt < next).length });
    }

    // Technician workload (staff only)
    let technicianWorkload: { name: string; open: number; completed: number }[] = [];
    if (staff) {
      const techs = await db.technicianProfile.findMany({ include: { user: true } });
      technicianWorkload = await Promise.all(techs.map(async (t) => ({
        name: t.user.name,
        open: await db.workOrder.count({ where: { technicianId: t.id, status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"] } } }),
        completed: await db.workOrder.count({ where: { technicianId: t.id, status: "COMPLETED" } }),
      })));
    }

    // Financial summary (staff: global; finance/super roles only get money figures)
    let financial: { invoiced: number; collected: number; outstanding: number; expenses: number } | null = null;
    if (staff && ["SUPER_ADMIN", "ADMIN", "FINANCE"].includes(user.role)) {
      const [invoicedAgg, paidAgg, expenseAgg] = await Promise.all([
        db.invoice.aggregate({ _sum: { totalCents: true }, where: { status: { notIn: ["DRAFT", "CANCELLED"] } } }),
        db.invoice.aggregate({ _sum: { paidCents: true }, where: { status: { notIn: ["DRAFT", "CANCELLED"] } } }),
        db.expense.aggregate({ _sum: { amountCents: true } }),
      ]);
      financial = {
        invoiced: invoicedAgg._sum.totalCents ?? 0,
        collected: paidAgg._sum.paidCents ?? 0,
        outstanding: (invoicedAgg._sum.totalCents ?? 0) - (paidAgg._sum.paidCents ?? 0),
        expenses: expenseAgg._sum.amountCents ?? 0,
      };
    }

    // Recent activity (module-specific)
    const recentComplaintList = await db.complaint.findMany({
      where: customerId ? { customerId } : {},
      orderBy: { createdAt: "desc" }, take: 6,
      select: { id: true, code: true, title: true, status: true, priority: true, createdAt: true, customer: { select: { companyName: true } } },
    });
    const recentWOs = await db.workOrder.findMany({
      where: customerId ? { customerId } : {},
      orderBy: { createdAt: "desc" }, take: 5,
      select: { id: true, code: true, title: true, status: true, technician: { select: { user: { select: { name: true } } } }, customer: { select: { companyName: true } } },
    });
    const upcomingPm = await db.pmTask.findMany({
      where: { status: { in: ["SCHEDULED", "IN_PROGRESS", "OVERDUE"] }, equipment: customerId ? { customerId } : {} },
      orderBy: { dueDate: "asc" }, take: 5,
      select: { id: true, code: true, dueDate: true, status: true, equipment: { select: { name: true, assetTag: true } } },
    });

    const equipmentStatusGroups = await db.equipment.groupBy({ by: ["status"], _count: { status: true }, where: customerId ? { customerId } : {} });

    // My scope for technicians
    let mine: { workOrders: number; pmTasks: number } | null = null;
    if (user.role === "TECHNICIAN") {
      const profile = await db.technicianProfile.findUnique({ where: { userId: user.id } });
      if (profile) {
        mine = {
          workOrders: await db.workOrder.count({ where: { technicianId: profile.id, status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"] } } }),
          pmTasks: await db.pmTask.count({ where: { technicianId: profile.id, status: { in: ["SCHEDULED", "OVERDUE", "IN_PROGRESS"] } } }),
        };
      }
    }

    return ok({
      kpis: { openComplaints, urgentComplaints, activeWOs, pendingWOs, overduePm, lowStock, equipmentDown, unreadNotifs },
      complaintStatusGroups, dailyComplaints: daily, technicianWorkload, financial,
      recentComplaints: recentComplaintList, recentWorkOrders: recentWOs, upcomingPm, equipmentStatusGroups, mine,
      role: user.role,
    });
  }
);
