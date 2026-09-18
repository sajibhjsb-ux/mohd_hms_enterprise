"use client";

// MOHD.HMS ENTERPRISE — Finance module
// Overview (KPIs + income vs expense chart + accounts + recent ledger),
// Receivables, Expenses (approval workflow) and Transactions tabs.
// Every figure is loaded live from /api/v1/finance/*.
//
// NAVIGATION ARCHITECTURE (hash router, ui-store pages["finance"]):
//   []                     → this list page (Overview tab)
//   ["expenses"]           → this list page (Expenses tab — deep-linkable)
//   ["expenses", "new"]    → FinanceNewExpensePage (dedicated add-expense page)
// Receivable rows navigate to the invoice detail pages via navigateTo.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { useSession, hasPerm } from "@/components/hms/session";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useUi } from "@/lib/hms/ui-store";
import { useToast } from "@/hooks/use-toast";
import { money, fmtDate } from "@/lib/hms/format";
import { PERMISSIONS } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Wallet, TrendingDown, TrendingUp, Receipt, Landmark, Plus, Check, BadgeDollarSign, RefreshCcw } from "lucide-react";
import { FinanceNewExpensePage } from "./new-expense-page";

// ── Types (mirror API responses) ──

type Summary = {
  kpis: {
    incomeCents: number; expensesCents: number; netProfitCents: number; receivablesCents: number;
    invoicedTotalCents: number; collectedTotalCents: number; pendingApprovalExpenses: number;
  };
  monthly: { month: string; income: number; expense: number }[];
  accounts: { id: string; code: string; name: string; type: string; balanceCents: number }[];
  recentTransactions: TransactionRow[];
  receivables: ReceivableRow[];
  recentExpenses: ExpenseRow[];
};

type ReceivableRow = {
  id: string; code: string; dueDate: string | null; status: string;
  totalCents: number; paidCents: number; balanceCents: number;
  customer: { id: string; code: string; companyName: string };
};

type ExpenseRow = {
  id: string; code: string; category: string; description: string; amountCents: number;
  expenseDate: string; status: string; receiptNo: string;
  supplier: { id: string; code: string; name: string } | null;
};

type TransactionRow = {
  id: string; code: string; type: string; category: string; description: string;
  amountCents: number; date: string; referenceType: string;
  account: { id: string; code: string; name: string; type: string } | null;
};

const INCOME_GREEN = "oklch(0.53 0.14 154)";
const EXPENSE_AMBER = "oklch(0.78 0.15 75)";

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}

/** Income / Expense badge with correct label and tone. */
function TypeBadge({ type }: { type: string }) {
  const income = type === "INCOME";
  return (
    <Badge variant="outline" className={cn("font-medium border-transparent whitespace-nowrap", income ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700")}>
      {income ? "Income" : "Expense"}
    </Badge>
  );
}

// ── Module router ──

export function FinanceModule() {
  const seg = useUi((s) => s.pages["finance"]) ?? [];
  const page = pageFromSeg(seg);

  // ["expenses", "new"] → pageFromSeg → { view: "expenses", id: "new" } → dedicated create page.
  if (page.view === "expenses" && page.id === "new") return <FinanceNewExpensePage />;

  // ["expenses"] → pageFromSeg → { view: "detail", id: "expenses" } → list on the Expenses tab.
  const initialTab = page.view === "detail" && page.id === "expenses" ? "expenses" : undefined;
  return <FinanceList key={initialTab ?? "list"} initialTab={initialTab} />;
}

// ── List page ──

function FinanceList({ initialTab }: { initialTab?: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const goToInvoices = (id?: string) => navigateTo("invoices", id ? [id] : []);
  const canRead = hasPerm(user, PERMISSIONS.finance_read);
  const canManage = hasPerm(user, PERMISSIONS.finance_manage);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [expLoading, setExpLoading] = useState(true);
  const [expError, setExpError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [trxLoading, setTrxLoading] = useState(true);
  const [trxError, setTrxError] = useState<string | null>(null);
  const [month, setMonth] = useState("");
  const [trxType, setTrxType] = useState("ALL");

  const [tab, setTab] = useState(initialTab ?? "overview");

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Summary>("/api/v1/finance/summary");
      setSummary(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadExpenses = useCallback(async () => {
    setExpLoading(true);
    setExpError(null);
    try {
      const res = await api.get<ExpenseRow[]>(`/api/v1/finance/expenses${qs({ pageSize: 200 })}`);
      setExpenses(res.data);
    } catch (e) {
      setExpError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setExpLoading(false);
    }
  }, []);

  const loadTransactions = useCallback(async (m: string, type: string) => {
    setTrxLoading(true);
    setTrxError(null);
    try {
      const res = await api.get<TransactionRow[]>(`/api/v1/finance/transactions${qs({ pageSize: 200, month: m || undefined, type: type === "ALL" ? undefined : type })}`);
      setTransactions(res.data);
    } catch (e) {
      setTrxError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setTrxLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canRead) { setLoading(false); return; }
    loadSummary();
    loadExpenses();
    loadTransactions(month, trxType);
  }, [canRead]);

  if (!canRead) {
    return (
      <EmptyState
        title="Finance access required"
        hint="Your role does not include finance visibility. You can review your invoices in the Invoices module."
        action={<Button size="sm" onClick={() => goToInvoices()}>Go to Invoices</Button>}
      />
    );
  }

  async function expenseTransition(id: string, action: "approve" | "mark_paid") {
    setBusyId(id);
    try {
      const res = await api.post<ExpenseRow>(`/api/v1/finance/expenses/${id}/transition`, { action });
      toast({
        title: action === "approve" ? `Expense ${res.data.code} approved` : `Expense ${res.data.code} paid`,
        description: action === "mark_paid" ? "An EXPENSE ledger transaction was recorded." : `Status: ${res.data.status}`,
      });
      await Promise.all([loadExpenses(), loadSummary()]);
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  const chartData = (summary?.monthly ?? []).map((m) => ({
    name: monthLabel(m.month),
    Income: m.income / 100,
    Expense: m.expense / 100,
  }));

  const receivableColumns: Column<ReceivableRow>[] = [
    { key: "code", header: "Invoice", value: (r) => r.code, render: (r) => <span className="font-medium">{r.code}</span> },
    { key: "customer", header: "Customer", value: (r) => r.customer?.companyName, className: "max-w-[200px] truncate" },
    { key: "dueDate", header: "Due", value: (r) => r.dueDate, render: (r) => fmtDate(r.dueDate) },
    { key: "totalCents", header: "Total", value: (r) => r.totalCents, render: (r) => <span className="tabular-nums">{money(r.totalCents)}</span>, hideOnMobile: true },
    { key: "balanceCents", header: "Balance", value: (r) => r.balanceCents, render: (r) => <span className="tabular-nums font-medium">{money(r.balanceCents)}</span> },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
  ];

  const expenseColumns: Column<ExpenseRow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, render: (r) => <span className="font-medium">{r.code}</span> },
    { key: "expenseDate", header: "Date", value: (r) => r.expenseDate, render: (r) => fmtDate(r.expenseDate), hideOnMobile: true },
    { key: "category", header: "Category", value: (r) => r.category },
    { key: "description", header: "Description", value: (r) => r.description, className: "max-w-[220px] truncate" },
    { key: "supplier", header: "Supplier", value: (r) => r.supplier?.name ?? "", render: (r) => r.supplier?.name ?? "—", hideOnMobile: true },
    { key: "amountCents", header: "Amount", value: (r) => r.amountCents, render: (r) => <span className="tabular-nums">{money(r.amountCents)}</span> },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    ...(canManage ? [{
      key: "actions", header: "Actions", sortable: false,
      render: (r: ExpenseRow) => (
        <div className="flex gap-1.5">
          {r.status === "PENDING" ? (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === r.id} onClick={() => expenseTransition(r.id, "approve")}>
              <Check className="h-3.5 w-3.5 mr-1" /> Approve
            </Button>
          ) : null}
          {r.status === "APPROVED" ? (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === r.id} onClick={() => expenseTransition(r.id, "mark_paid")}>
              <BadgeDollarSign className="h-3.5 w-3.5 mr-1" /> Mark paid
            </Button>
          ) : null}
          {r.status === "PAID" ? <span className="text-xs text-muted-foreground self-center">Settled</span> : null}
        </div>
      ),
    } as Column<ExpenseRow>] : []),
  ];

  const transactionColumns: Column<TransactionRow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, render: (r) => <span className="font-medium">{r.code}</span> },
    { key: "date", header: "Date", value: (r) => r.date, render: (r) => fmtDate(r.date) },
    { key: "type", header: "Type", value: (r) => r.type, render: (r) => <TypeBadge type={r.type} /> },
    { key: "category", header: "Category", value: (r) => r.category, hideOnMobile: true },
    { key: "description", header: "Description", value: (r) => r.description, className: "max-w-[220px] truncate" },
    { key: "account", header: "Account", value: (r) => r.account?.name ?? "", render: (r) => r.account?.name ?? "—", hideOnMobile: true },
    { key: "amountCents", header: "Amount", value: (r) => (r.type === "INCOME" ? r.amountCents : -r.amountCents),
      render: (r) => <span className={r.type === "INCOME" ? "tabular-nums text-emerald-700" : "tabular-nums text-red-700"}>{r.type === "INCOME" ? "+" : "−"}{money(r.amountCents)}</span> },
  ];

  const k = summary?.kpis;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Finance"
        subtitle="Income, expenses, receivables and the general ledger"
        actions={<Button variant="outline" size="sm" onClick={() => { loadSummary(); loadExpenses(); loadTransactions(month, trxType); }}><RefreshCcw className="h-4 w-4 mr-1.5" /> Refresh</Button>}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 flex-wrap h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="receivables">Receivables{summary ? ` (${summary.receivables.length})` : ""}</TabsTrigger>
          <TabsTrigger value="expenses">Expenses{summary ? ` (${summary.kpis.pendingApprovalExpenses})` : ""}</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
        </TabsList>

        {/* ── Overview ── */}
        <TabsContent value="overview" className="space-y-5">
          {error ? <ErrorState message={error} onRetry={loadSummary} /> : null}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard title="Income" value={money(k?.incomeCents)} sub="All ledger income" icon={<TrendingUp className="h-5 w-5" />} tone="success" loading={loading} />
            <StatCard title="Expenses" value={money(k?.expensesCents)} sub="All recorded expenses" icon={<TrendingDown className="h-5 w-5" />} tone="warning" loading={loading} />
            <StatCard title="Net profit" value={money(k?.netProfitCents)} sub="Income − expenses" icon={<Wallet className="h-5 w-5" />} tone={(k?.netProfitCents ?? 0) >= 0 ? "success" : "danger"} loading={loading} />
            <StatCard title="Receivables" value={money(k?.receivablesCents)} sub="Outstanding balances" icon={<Receipt className="h-5 w-5" />} tone={(k?.receivablesCents ?? 0) > 0 ? "default" : "success"} loading={loading} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle className="text-base">Income vs Expense — last 6 months</CardTitle></CardHeader>
              <CardContent className="h-64">
                {loading ? <LoadingState rows={2} /> : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0 0)" />
                      <XAxis dataKey="name" fontSize={11} tickLine={false} />
                      <YAxis fontSize={11} tickLine={false} tickFormatter={(v: number) => `RM${v >= 1000 ? `${Math.round(v / 1000)}k` : v}`} />
                      <Tooltip formatter={(value) => money(Number(value) * 100)} />
                      <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="Income" fill={INCOME_GREEN} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="Expense" fill={EXPENSE_AMBER} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Landmark className="h-4 w-4 text-primary" /> Accounts</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {loading ? <LoadingState rows={2} /> : (summary?.accounts.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No accounts configured</p>
                ) : (
                  summary?.accounts.map((a) => (
                    <div key={a.id} className="flex items-center justify-between rounded-lg border p-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{a.name}</div>
                        <div className="text-xs text-muted-foreground">{a.code} · {a.type.replaceAll("_", " ")}</div>
                      </div>
                      <div className="text-sm font-semibold tabular-nums">{money(a.balanceCents)}</div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Recent transactions</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? <LoadingState rows={3} /> : (summary?.recentTransactions.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No ledger transactions yet</p>
              ) : (
                <div className="divide-y">
                  {summary?.recentTransactions.map((t) => (
                    <div key={t.id} className="py-2.5 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{t.description || t.category}</div>
                        <div className="text-xs text-muted-foreground">{t.code} · {t.account?.name ?? "No account"} · {fmtDate(t.date)}</div>
                      </div>
                      <TypeBadge type={t.type} />
                      <span className={`text-sm tabular-nums font-medium ${t.type === "INCOME" ? "text-emerald-700" : "text-red-700"}`}>
                        {t.type === "INCOME" ? "+" : "−"}{money(t.amountCents)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Receivables ── */}
        <TabsContent value="receivables">
          {loading ? (
            <LoadingState label="Loading receivables…" />
          ) : (summary?.receivables.length ?? 0) === 0 ? (
            <EmptyState title="No outstanding receivables" hint="All issued invoices are fully collected." />
          ) : (
            <DataTable
              columns={receivableColumns}
              rows={summary?.receivables ?? []}
              rowKey={(r) => r.id}
              onRowClick={(r) => goToInvoices(r.id)}
              searchPlaceholder="Search receivables…"
              exportName="receivables"
              emptyTitle="No receivables"
              pageSizeDefault={10}
            />
          )}
        </TabsContent>

        {/* ── Expenses ── */}
        <TabsContent value="expenses">
          {expError ? <ErrorState message={expError} onRetry={loadExpenses} /> : null}
          <div className="flex justify-end mb-3 no-print">
            {canManage ? (
              <Button size="sm" onClick={() => navigateTo("finance", ["expenses", "new"])}><Plus className="h-4 w-4 mr-1.5" /> Add expense</Button>
            ) : null}
          </div>
          {expLoading ? (
            <LoadingState label="Loading expenses…" />
          ) : expenses.length === 0 ? (
            <EmptyState
              title="No expenses recorded"
              hint={canManage ? "Submit the first expense for approval." : "Expenses will appear here once submitted."}
              action={canManage ? <Button size="sm" onClick={() => navigateTo("finance", ["expenses", "new"])}><Plus className="h-4 w-4 mr-1.5" /> Add expense</Button> : undefined}
            />
          ) : (
            <DataTable
              columns={expenseColumns}
              rows={expenses}
              rowKey={(r) => r.id}
              searchPlaceholder="Search expenses…"
              filters={[{
                key: "status", label: "Status",
                options: ["PENDING", "APPROVED", "PAID"].map((s) => ({ value: s, label: s.replaceAll("_", " ") })),
                match: (r, v) => r.status === v,
              }]}
              exportName="expenses"
              emptyTitle="No expenses match"
            />
          )}
        </TabsContent>

        {/* ── Transactions ── */}
        <TabsContent value="transactions">
          <div className="flex flex-col sm:flex-row justify-end gap-2 mb-3 no-print">
            <Input
              type="month"
              className="w-full sm:w-48"
              value={month}
              onChange={(e) => { setMonth(e.target.value); loadTransactions(e.target.value, trxType); }}
              aria-label="Filter by month"
            />
            {month ? (
              <Button variant="ghost" size="sm" onClick={() => { setMonth(""); loadTransactions("", trxType); }}>Clear</Button>
            ) : null}
          </div>
          {trxError ? (
            <ErrorState message={trxError} onRetry={() => loadTransactions(month, trxType)} />
          ) : trxLoading ? (
            <LoadingState label="Loading transactions…" />
          ) : transactions.length === 0 ? (
            <EmptyState title="No transactions found" hint="Ledger entries appear when payments are received or expenses are paid." />
          ) : (
            <DataTable
              columns={transactionColumns}
              rows={transactions}
              rowKey={(r) => r.id}
              searchPlaceholder="Search transactions…"
              filters={[{
                key: "type", label: "Type",
                options: [{ value: "INCOME", label: "Income" }, { value: "EXPENSE", label: "Expense" }],
                match: (r, v) => r.type === v,
              }]}
              exportName="transactions"
              emptyTitle="No transactions match"
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
