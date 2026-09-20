// MOHD.HMS ENTERPRISE — Reports API: aggregated report data by type + date range.
// GET /api/v1/reports?type=complaints|work_orders|equipment|pm_compliance|finance|technicians|payroll&from=YYYY-MM-DD&to=YYYY-MM-DD

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { isStaff } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";

const REPORT_TYPES = ["complaints", "work_orders", "equipment", "pm_compliance", "finance", "technicians", "payroll"] as const;
type ReportType = (typeof REPORT_TYPES)[number];

type Row = Record<string, string | number | null>;
type Summary = Record<string, number | Record<string, number>>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function parseRange(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  if (fromRaw && !DATE_RE.test(fromRaw)) throw Errors.badRequest("`from` must be a YYYY-MM-DD date.");
  if (toRaw && !DATE_RE.test(toRaw)) throw Errors.badRequest("`to` must be a YYYY-MM-DD date.");

  let from: Date;
  let to: Date;
  if (fromRaw) {
    from = new Date(`${fromRaw}T00:00:00.000Z`);
  } else {
    from = new Date();
    from.setUTCDate(from.getUTCDate() - 29);
    from.setUTCHours(0, 0, 0, 0);
  }
  if (toRaw) {
    to = new Date(`${toRaw}T23:59:59.999Z`);
  } else {
    to = new Date();
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw Errors.badRequest("Invalid date range.");
  if (from.getTime() > to.getTime()) throw Errors.badRequest("`from` must be on or before `to`.");
  return { from, to, fromStr: from.toISOString().slice(0, 10), toStr: to.toISOString().slice(0, 10) };
}

function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function buildReport(type: ReportType, from: Date, to: Date, user: SessionUser) {
  // Defensive customer scoping (reports.read is staff-only today, but stay safe).
  const scoped = !isStaff(user.role);
  const customerId = scoped ? (user.customerId ?? "none") : undefined;

  switch (type) {
    case "complaints": {
      const complaints = await db.complaint.findMany({
        where: { createdAt: { gte: from, lte: to }, ...(customerId ? { customerId } : {}) },
        include: {
          customer: { select: { companyName: true } },
          equipment: { select: { name: true } },
          assignedTechnician: { include: { user: { select: { name: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
      const rows: Row[] = complaints.map((c) => ({
        code: c.code,
        date: toIso(c.createdAt),
        customer: c.customer.companyName,
        equipment: c.equipment?.name ?? "—",
        priority: c.priority,
        status: c.status,
        technician: c.assignedTechnician?.user.name ?? "Unassigned",
      }));
      const summary: Summary = {
        total: rows.length,
        byStatus: countBy(complaints, (c) => c.status),
        byPriority: countBy(complaints, (c) => c.priority),
      };
      return { summary, rows };
    }

    case "work_orders": {
      const wos = await db.workOrder.findMany({
        where: { createdAt: { gte: from, lte: to }, ...(customerId ? { customerId } : {}) },
        include: {
          customer: { select: { companyName: true } },
          technician: { include: { user: { select: { name: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
      const rows: Row[] = wos.map((w) => ({
        code: w.code,
        date: toIso(w.createdAt),
        customer: w.customer.companyName,
        technician: w.technician?.user.name ?? "Unassigned",
        status: w.status,
        labourHours: w.labourHours,
        totalCents: w.totalCents,
      }));
      const live = wos.filter((w) => w.status !== "CANCELLED");
      const summary: Summary = {
        total: rows.length,
        completed: wos.filter((w) => w.status === "COMPLETED").length,
        totalValueCents: live.reduce((sum, w) => sum + w.totalCents, 0),
      };
      return { summary, rows };
    }

    case "equipment": {
      // Point-in-time asset report (date range accepted but not applied).
      const equipment = await db.equipment.findMany({
        where: customerId ? { customerId } : {},
        include: { customer: { select: { companyName: true } } },
        orderBy: { assetTag: "asc" },
      });
      const rows: Row[] = equipment.map((e) => ({
        assetTag: e.assetTag,
        name: e.name,
        customer: e.customer?.companyName ?? "—",
        status: e.status,
        warrantyExpiry: toIso(e.warrantyExpiry),
      }));
      const summary: Summary = {
        total: rows.length,
        active: equipment.filter((e) => e.status === "ACTIVE").length,
        underMaintenance: equipment.filter((e) => e.status === "UNDER_MAINTENANCE").length,
      };
      return { summary, rows };
    }

    case "pm_compliance": {
      const tasks = await db.pmTask.findMany({
        where: { dueDate: { gte: from, lte: to }, ...(customerId ? { equipment: { customerId } } : {}) },
        include: {
          plan: { select: { name: true } },
          equipment: { select: { name: true } },
        },
        orderBy: { dueDate: "asc" },
      });
      const rows: Row[] = tasks.map((t) => ({
        code: t.code,
        plan: t.plan.name,
        equipment: t.equipment.name,
        dueDate: toIso(t.dueDate),
        status: t.status,
        completedAt: toIso(t.completedAt),
      }));
      const scheduled = tasks.filter((t) => t.status === "SCHEDULED" || t.status === "IN_PROGRESS").length;
      const overdue = tasks.filter((t) => t.status === "OVERDUE").length;
      const completed = tasks.filter((t) => t.status === "COMPLETED").length;
      const denom = scheduled + overdue + completed;
      const summary: Summary = {
        scheduled,
        overdue,
        completed,
        completionRate: denom > 0 ? Math.round((completed / denom) * 1000) / 10 : 0,
      };
      return { summary, rows };
    }

    case "finance": {
      const invoices = await db.invoice.findMany({
        where: { invoiceDate: { gte: from, lte: to }, ...(customerId ? { customerId } : {}) },
        include: { customer: { select: { companyName: true } } },
        orderBy: { invoiceDate: "desc" },
      });
      const expenses = await db.expense.findMany({
        where: { expenseDate: { gte: from, lte: to } },
        orderBy: { expenseDate: "desc" },
      });
      const rows: Row[] = invoices.map((i) => ({
        code: i.code,
        date: toIso(i.invoiceDate),
        customer: i.customer.companyName,
        totalCents: i.totalCents,
        paidCents: i.paidCents,
        balanceCents: i.balanceCents,
        status: i.status,
      }));
      const expenseRows: Row[] = expenses.map((e) => ({
        code: e.code,
        date: toIso(e.expenseDate),
        category: e.category,
        description: e.description || "—",
        amountCents: e.amountCents,
        status: e.status,
      }));
      // Booked figures exclude drafts/cancelled (consistent with dashboard).
      const booked = invoices.filter((i) => !["DRAFT", "CANCELLED"].includes(i.status));
      const summary: Summary = {
        invoicedCents: booked.reduce((s, i) => s + i.totalCents, 0),
        collectedCents: booked.reduce((s, i) => s + i.paidCents, 0),
        outstandingCents: booked.reduce((s, i) => s + i.balanceCents, 0),
        expensesCents: expenses.reduce((s, e) => s + e.amountCents, 0),
      };
      return { summary, rows, expenses: expenseRows };
    }

    case "payroll": {
      // Payroll register (spec §42): one row per employee per finalized+ run in
      // the range. Salary data is reports_read-gated at the route level; the
      // rows keep the house `*Cents` naming so CSV export divides by 100.
      const runs = await db.payrollRun.findMany({
        where: { periodStart: { gte: from, lte: to }, status: { in: ["REVIEW", "APPROVED", "FINALIZED", "PAID", "LOCKED"] } },
        orderBy: { periodStart: "asc" },
        select: { id: true, code: true, name: true, status: true },
      });
      const items = runs.length
        ? await db.payrollItem.findMany({
            where: { runId: { in: runs.map((r) => r.id) }, status: "CALCULATED" },
            orderBy: { employeeNo: "asc" },
          })
        : [];
      const runById = new Map(runs.map((r) => [r.id, r]));
      const rows: Row[] = items.map((i) => ({
        run: runById.get(i.runId)?.code ?? "",
        period: runById.get(i.runId)?.name ?? "",
        employeeNo: i.employeeNo,
        employee: i.employeeName,
        department: i.departmentName,
        position: i.positionName,
        basicCents: i.basicCents,
        allowancesCents: i.allowancesCents,
        overtimeCents: i.overtimeCents,
        grossCents: i.grossCents,
        deductionsCents: i.deductionsCents,
        netCents: i.netCents,
        status: i.status,
      }));
      const summary: Summary = {
        runs: runs.length,
        employees: new Set(items.map((i) => i.employeeId)).size,
        grossCents: items.reduce((s, i) => s + i.grossCents, 0),
        deductionsCents: items.reduce((s, i) => s + i.deductionsCents, 0),
        employerCostCents: items.reduce((s, i) => s + i.employerCostCents, 0),
        netCents: items.reduce((s, i) => s + i.netCents, 0),
      };
      return { summary, rows };
    }

    case "technicians": {
      const techs = await db.technicianProfile.findMany({
        include: { user: { select: { name: true, email: true } } },
        orderBy: { employeeNo: "asc" },
      });
      const openWoStatuses = ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"];
      const openComplaintStatuses = ["NEW", "ASSIGNED", "IN_PROGRESS"];
      const rows: Row[] = await Promise.all(
        techs.map(async (t) => ({
          name: t.user.name,
          employeeNo: t.employeeNo,
          specialty: t.specialty,
          openWOs: await db.workOrder.count({ where: { technicianId: t.id, status: { in: openWoStatuses } } }),
          completedWOs: await db.workOrder.count({
            where: { technicianId: t.id, status: "COMPLETED", completedAt: { gte: from, lte: to } },
          }),
          openComplaints: await db.complaint.count({
            where: { assignedTechnicianId: t.id, status: { in: openComplaintStatuses } },
          }),
        }))
      );
      const summary: Summary = {
        technicians: rows.length,
        openWOs: rows.reduce((s, r) => s + Number(r.openWOs ?? 0), 0),
        completedWOs: rows.reduce((s, r) => s + Number(r.completedWOs ?? 0), 0),
        openComplaints: rows.reduce((s, r) => s + Number(r.openComplaints ?? 0), 0),
      };
      return { summary, rows };
    }
  }
}

export const GET = handler(
  async ({ req, user }) => {
    const typeSchema = z.enum(REPORT_TYPES);
    const typeRaw = new URL(req.url).searchParams.get("type") ?? "complaints";
    const parsed = typeSchema.safeParse(typeRaw);
    if (!parsed.success) {
      throw Errors.badRequest(`Unknown report type. Valid types: ${REPORT_TYPES.join(", ")}.`);
    }
    const { from, to, fromStr, toStr } = parseRange(req);
    const { summary, rows, ...extra } = await buildReport(parsed.data, from, to, user);
    return ok({ type: parsed.data, from: fromStr, to: toStr, summary, rows, ...extra });
  },
  { permission: PERMISSIONS.reports_read }
);
