// MOHD.HMS ENTERPRISE — Petty cash summary (spec §40-§41).
//
//   GET /api/v1/finance/petty-cash/summary
//
// Feeds the Reports sub-tab: fund balances (with custodian + approved in/out
// aggregates), the last 6 months of approved IN vs OUT, top categories of
// approved OUT flows, top requesters of EXPENSE/REIMBURSEMENT, and the
// pending-approval count.

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

const CUSTODIAN_SELECT = { id: true, name: true, email: true } as const;

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export const GET = handler(async () => {
  const now = new Date();
  const monthsStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [funds, dirAgg, pendingRows, recentApproved, pendingCount] = await Promise.all([
    db.pettyCashFund.findMany({
      orderBy: { createdAt: "desc" },
      include: { custodian: { select: CUSTODIAN_SELECT } },
    }),
    db.pettyCashTransaction.groupBy({
      by: ["fundId", "direction"],
      where: { status: "APPROVED" },
      _sum: { amountCents: true },
    }),
    db.pettyCashTransaction.groupBy({
      by: ["fundId"],
      where: { status: "PENDING" },
      _count: { _all: true },
    }),
    // Approved flows since the start of the 6-month window (monthly + category
    // + requester breakdowns are computed in JS — SQLite-safe, no raw SQL).
    db.pettyCashTransaction.findMany({
      where: { status: "APPROVED", txDate: { gte: monthsStart } },
      select: { direction: true, type: true, amountCents: true, category: true, requesterName: true, txDate: true },
    }),
    db.pettyCashTransaction.count({ where: { status: "PENDING" } }),
  ]);

  const inByFund = new Map<string, number>();
  const outByFund = new Map<string, number>();
  for (const row of dirAgg) {
    if (row.direction === "IN") inByFund.set(row.fundId, row._sum.amountCents ?? 0);
    else outByFund.set(row.fundId, row._sum.amountCents ?? 0);
  }
  const pendingByFund = new Map(pendingRows.map((r) => [r.fundId, r._count._all]));

  // Monthly approved IN vs OUT — last 6 calendar months, zero-filled.
  const monthly: { month: string; inCents: number; outCents: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    monthly.push({ month: monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)), inCents: 0, outCents: 0 });
  }
  const monthIndex = new Map(monthly.map((m, idx) => [m.month, idx]));
  const categoryTotals = new Map<string, number>();
  const requesterTotals = new Map<string, number>();
  for (const t of recentApproved) {
    const idx = monthIndex.get(monthKey(new Date(t.txDate)));
    if (idx !== undefined) {
      if (t.direction === "IN") monthly[idx].inCents += t.amountCents;
      else monthly[idx].outCents += t.amountCents;
    }
    if (t.direction === "OUT") {
      const cat = t.category || "GENERAL";
      categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + t.amountCents);
    }
    if (t.type === "EXPENSE" || t.type === "REIMBURSEMENT") {
      const name = t.requesterName || "Unattributed";
      requesterTotals.set(name, (requesterTotals.get(name) ?? 0) + t.amountCents);
    }
  }

  const byCategory = [...categoryTotals.entries()]
    .map(([category, amountCents]) => ({ category, amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 10);

  const byRequester = [...requesterTotals.entries()]
    .map(([requester, amountCents]) => ({ requester, amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 10);

  return ok({
    funds: funds.map((f) => ({
      ...f,
      totalInCents: inByFund.get(f.id) ?? 0,
      totalOutCents: outByFund.get(f.id) ?? 0,
      pendingCount: pendingByFund.get(f.id) ?? 0,
    })),
    monthly,
    byCategory,
    byRequester,
    pendingCount,
  });
}, { permission: PERMISSIONS.finance_read });
