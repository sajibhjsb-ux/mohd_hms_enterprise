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
import { PageHeader, StatCard, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { useSession, hasPerm } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { money, fmtDate } from "@/lib/hms/format";
import { PERMISSIONS } from "@/lib/hms/constants";
import { CircleDollarSign, Plus, TriangleAlert, Wallet } from "lucide-react";
import { InvoiceNewPage } from "./new-page";
import { InvoiceDetailPage } from "./detail-page";
import { InvoicePaymentPage } from "./payment-page";
import type { InvoiceRow } from "./shared";

// ── Module router ──

export function InvoicesModule() {
  const seg = useUi((s) => s.pages["invoices"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "new") return <InvoiceNewPage />;
  if (page.view === "payment" && page.id) return <InvoicePaymentPage id={page.id} />;
  if (page.view === "detail" && page.id) return <InvoiceDetailPage id={page.id} />;
  return <InvoicesList />;
}

// ── List page ──

function InvoicesList() {
  const { user } = useSession();
  const canManage = hasPerm(user, PERMISSIONS.invoices_manage);

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
          filters={[{
            key: "status", label: "Status",
            options: ["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"].map((s) => ({ value: s, label: s.replaceAll("_", " ") })),
            match: (r, v) => r.status === v,
          }]}
          exportName="invoices"
          emptyTitle="No invoices match"
        />
      )}
    </div>
  );
}
