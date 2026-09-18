"use client";

// MOHD.HMS ENTERPRISE — Invoices module (list page).
// Billing, payments and collections. Create, detail and payment flows are
// DEDICATED PAGES routed by the hash router (no popup CRUD):
//   []                     → this list page
//   ["new"]                → InvoiceNewPage
//   [id]                   → InvoiceDetailPage
//   [id, "payment"]        → InvoicePaymentPage

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, EmptyState, ErrorState, DrilldownChips } from "@/components/hms/shared/ui-bits";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { useSession, hasPerm } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useModuleQuery } from "@/lib/hms/page-query";
import { money, fmtDate } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { CircleDollarSign, Plus, TriangleAlert, Wallet } from "lucide-react";
import { InvoiceNewPage } from "./new-page";
import { InvoiceDetailPage } from "./detail-page";
import { InvoicePaymentPage } from "./payment-page";
import type { InvoiceRow } from "./shared";

/** Status filter options — "outstanding" is the drill-down view for any
 *  invoice with a balance due (SENT | PARTIALLY_PAID | OVERDUE), matching the
 *  dashboard "Outstanding" KPI (total invoiced − collected). */
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "outstanding", label: "Outstanding (balance due)" },
  ...["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"].map((s) => ({ value: s, label: s.replaceAll("_", " ") })),
];

function matchInvoiceStatus(r: InvoiceRow, v: string): boolean {
  if (v === "outstanding") return ["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(r.status);
  return r.status === v;
}

// ── Module router ──

export function InvoicesModule() {
  const seg = useUi((s) => s.pages["invoices"]) ?? [];
  const query = useUi((s) => s.queries["invoices"] ?? "");
  const page = pageFromSeg(seg);

  if (page.view === "new") return <InvoiceNewPage />;
  if (page.view === "payment" && page.id) return <InvoicePaymentPage id={page.id} />;
  if (page.view === "detail" && page.id) return <InvoiceDetailPage id={page.id} />;
  // key={query}: a new drill-down URL (KPI click / direct link) remounts the
  // list with the query applied as its initial filter state.
  return <InvoicesList key={query} />;
}

// ── List page ──

function InvoicesList() {
  const { user } = useSession();
  const canManage = hasPerm(user, PERMISSIONS.invoices_manage);

  // KPI drill-down (e.g. /invoices?status=outstanding|PAID): validated against
  // the status filter options, then applied once on mount.
  const dq = useModuleQuery("invoices");
  const statusParam = STATUS_OPTIONS.find((o) => o.value.toLowerCase() === dq.params.status?.toLowerCase())?.value;

  // All page navigation flows through the hash router (URL + Back/Forward).
  const openPage = useCallback((seg: string[]) => navigateTo("invoices", seg), []);

  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [meta, setMeta] = useState<{ outstandingCents: number; overdueCount: number; paidThisMonthCents: number }>({ outstandingCents: 0, overdueCount: 0, paidThisMonthCents: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<InvoiceRow[]>(`/api/v1/invoices${qs({ pageSize: 200 })}`);
      setRows(res.data);
      const m = res.meta ?? {};
      setMeta({
        outstandingCents: typeof m.outstandingCents === "number" ? m.outstandingCents : 0,
        overdueCount: typeof m.overdueCount === "number" ? m.overdueCount : 0,
        paidThisMonthCents: typeof m.paidThisMonthCents === "number" ? m.paidThisMonthCents : 0,
      });
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime (STEP 14): invoice created/sent/payment updates the list + KPIs live.
  useRealtimeEvent(MODULE_EVENTS.invoices, () => { void load(); });

  const columns: Column<InvoiceRow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, render: (r) => <span className="font-medium">{r.code}</span> },
    { key: "customer", header: "Customer", value: (r) => r.customer?.companyName, className: "max-w-[160px] truncate" },
    { key: "invoiceDate", header: "Date", value: (r) => r.invoiceDate, render: (r) => fmtDate(r.invoiceDate), hideOnMobile: true },
    { key: "dueDate", header: "Due", value: (r) => r.dueDate, render: (r) => fmtDate(r.dueDate), hideOnMobile: true },
    { key: "totalCents", header: "Total", value: (r) => r.totalCents, render: (r) => <span className="tabular-nums">{money(r.totalCents)}</span> },
    { key: "paidCents", header: "Paid", value: (r) => r.paidCents, render: (r) => <span className="tabular-nums text-emerald-700">{money(r.paidCents)}</span>, hideOnMobile: true },
    { key: "balanceCents", header: "Balance", value: (r) => r.balanceCents, render: (r) => <span className="tabular-nums">{money(r.balanceCents)}</span> },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle="Billing, payments and collections"
        actions={canManage ? (
          <Button size="sm" onClick={() => openPage(["new"])}>
            <Plus className="h-4 w-4 mr-1.5" /> New Invoice
          </Button>
        ) : null}
      />

      <DrilldownChips
        chips={statusParam ? [{ key: "status", label: "Status", value: STATUS_OPTIONS.find((o) => o.value === statusParam)?.label ?? humanize(statusParam) }] : []}
        onRemove={(key) => dq.apply({ [key]: undefined })}
        onClear={dq.clear}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <StatCard title="Outstanding" value={money(meta.outstandingCents)} sub="Sent, partial & overdue" icon={<Wallet className="h-5 w-5" />} loading={loading} />
        <StatCard title="Overdue invoices" value={meta.overdueCount} icon={<TriangleAlert className="h-5 w-5" />} tone={meta.overdueCount > 0 ? "danger" : "success"} loading={loading} />
        <StatCard title="Collected this month" value={money(meta.paidThisMonthCents)} icon={<CircleDollarSign className="h-5 w-5" />} tone="success" loading={loading} />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <LoadingState label="Loading invoices…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No invoices yet"
          hint={canManage ? "Create a manual invoice or convert an approved quotation." : "Invoices shared with you will appear here."}
          action={canManage ? <Button size="sm" onClick={() => openPage(["new"])}><Plus className="h-4 w-4 mr-1.5" /> New Invoice</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => openPage([r.id])}
          searchPlaceholder="Search invoices…"
          initialFilters={statusParam ? { status: statusParam } : undefined}
          filters={[{ key: "status", label: "Status", options: STATUS_OPTIONS, match: matchInvoiceStatus }]}
          exportName="invoices"
          emptyTitle="No invoices match"
        />
      )}
    </div>
  );
}
