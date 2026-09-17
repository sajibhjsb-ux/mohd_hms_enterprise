// MOHD.HMS ENTERPRISE — Finance summary: KPIs, 6-month income vs expense, accounts,
// receivables, recent transactions and expenses (all live aggregates)

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { isStaff } from "@/lib/hms/rbac";
import type { Prisma } from "@prisma/client";

const OPEN_INVOICE_STATUSES = ["SENT", "PARTIALLY_PAID", "OVERDUE"];

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export const GET = handler(async ({ user }) => {
  const scope: Prisma.InvoiceWhereInput = isStaff(user.role) ? {} : { customerId: user.customerId ?? "__none__" };

  const now = new Date();
  const monthsBack = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [incomeAgg, expenseAgg, receivablesAgg, invoicedAgg, collectedAgg, pendingExpenses, transactions, accounts, receivableInvoices, recentExpenses] = await Promise.all([
    db.transaction.aggregate({ where: { type: "INCOME" }, _sum: { amountCents: true } }),
    db.expense.aggregate({ _sum: { amountCents: true } }),
    db.invoice.aggregate({ where: { ...scope, status: { in: OPEN_INVOICE_STATUSES } }, _sum: { balanceCents: true } }),
    db.invoice.aggregate({ where: { ...scope, status: { not: "CANCELLED" } }, _sum: { totalCents: true } }),
    db.invoice.aggregate({ where: { ...scope, status: { not: "CANCELLED" } }, _sum: { paidCents: true } }),
    db.expense.count({ where: { status: "PENDING" } }),
    db.transaction.findMany({
      where: { date: { gte: monthsBack } },
      orderBy: { date: "asc" },
      select: { type: true, amountCents: true, date: true },
    }),
    db.account.findMany({ orderBy: { code: "asc" } }),
    db.invoice.findMany({
      where: { ...scope, status: { in: OPEN_INVOICE_STATUSES }, balanceCents: { gt: 0 } },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
      take: 20,
      include: { customer: { select: { id: true, code: true, companyName: true } } },
    }),
    db.expense.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { supplier: { select: { id: true, code: true, name: true } } },
    }),
  ]);

  // 6-month income vs expense computed in JS from the fetched transactions.
  const monthly: { month: string; income: number; expense: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthly.push({ month: monthKey(d), income: 0, expense: 0 });
  }
  const byKey = new Map(monthly.map((m) => [m.month, m]));
  for (const t of transactions) {
    const bucket = byKey.get(monthKey(new Date(t.date)));
    if (!bucket) continue;
    if (t.type === "INCOME") bucket.income += t.amountCents;
    else if (t.type === "EXPENSE") bucket.expense += t.amountCents;
  }

  const recentTransactions = await db.transaction.findMany({
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 10,
    include: { account: { select: { id: true, code: true, name: true, type: true } } },
  });

  const incomeCents = incomeAgg._sum.amountCents ?? 0;
  const expenseCents = expenseAgg._sum.amountCents ?? 0;

  return ok({
    kpis: {
      incomeCents,
      expensesCents: expenseCents,
      netProfitCents: incomeCents - expenseCents,
      receivablesCents: receivablesAgg._sum.balanceCents ?? 0,
      invoicedTotalCents: invoicedAgg._sum.totalCents ?? 0,
      collectedTotalCents: collectedAgg._sum.paidCents ?? 0,
      pendingApprovalExpenses: pendingExpenses,
    },
    monthly,
    accounts,
    recentTransactions,
    receivables: receivableInvoices,
    recentExpenses,
    generatedAt: now.toISOString(),
  });
}, { permission: PERMISSIONS.finance_read });
