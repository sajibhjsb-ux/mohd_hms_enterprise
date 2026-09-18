"use client";

// MOHD.HMS ENTERPRISE — Quotations module (list page).
// Draft → Sent → Approved/Rejected/Expired → Converted. Create, detail and
// convert flows are DEDICATED PAGES routed by the hash router (no popup CRUD):
//   []                  → this list page
//   ["new"]             → QuotationNewPage
//   [id]                → QuotationDetailPage

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
import { Check, FileText, Plus, Repeat, Send } from "lucide-react";
import { QuotationNewPage } from "./new-page";
import { QuotationDetailPage } from "./detail-page";
import type { QuotationRow } from "./shared";

// ── Module router ──

export function QuotationsModule() {
  const seg = useUi((s) => s.pages["quotations"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "new") return <QuotationNewPage />;
  if (page.view === "detail" && page.id) return <QuotationDetailPage id={page.id} />;
  return <QuotationsList />;
}

// ── List page ──

function QuotationsList() {
  const { user } = useSession();
  const canManage = hasPerm(user, PERMISSIONS.quotations_manage);

  // All page navigation flows through the hash router (URL + Back/Forward).
  const openPage = useCallback((seg: string[]) => navigateTo("quotations", seg), []);

  const [rows, setRows] = useState<QuotationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<QuotationRow[]>(`/api/v1/quotations${qs({ pageSize: 200 })}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => ({
    draft: rows.filter((r) => r.status === "DRAFT").length,
    sent: rows.filter((r) => r.status === "SENT").length,
    approved: rows.filter((r) => r.status === "APPROVED").length,
    convertedValue: rows.filter((r) => r.status === "CONVERTED").reduce((s, r) => s + r.totalCents, 0),
  }), [rows]);

  const columns: Column<QuotationRow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, render: (r) => <span className="font-medium">{r.code}</span> },
    { key: "customer", header: "Customer", value: (r) => r.customer?.companyName, className: "max-w-[180px] truncate" },
    { key: "quotationDate", header: "Date", value: (r) => r.quotationDate, render: (r) => fmtDate(r.quotationDate), hideOnMobile: true },
    { key: "validUntil", header: "Valid until", value: (r) => r.validUntil, render: (r) => fmtDate(r.validUntil), hideOnMobile: true },
    { key: "totalCents", header: "Total", value: (r) => r.totalCents, render: (r) => <span className="tabular-nums">{money(r.totalCents)}</span> },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div>
      <PageHeader
        title="Quotations"
        subtitle="Prepare, send and convert customer quotations"
        actions={canManage ? (
          <Button size="sm" onClick={() => openPage(["new"])}>
            <Plus className="h-4 w-4 mr-1.5" /> New Quotation
          </Button>
        ) : null}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard title="Draft" value={stats.draft} icon={<FileText className="h-5 w-5" />} loading={loading} />
        <StatCard title="Sent" value={stats.sent} icon={<Send className="h-5 w-5" />} loading={loading} />
        <StatCard title="Approved" value={stats.approved} icon={<Check className="h-5 w-5" />} tone="success" loading={loading} />
        <StatCard title="Converted value" value={money(stats.convertedValue)} icon={<Repeat className="h-5 w-5" />} loading={loading} />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <LoadingState label="Loading quotations…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No quotations yet"
          hint={canManage ? "Create your first quotation to start the sales workflow." : "Quotations shared with you will appear here."}
          action={canManage ? <Button size="sm" onClick={() => openPage(["new"])}><Plus className="h-4 w-4 mr-1.5" /> New Quotation</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => openPage([r.id])}
          searchPlaceholder="Search quotations…"
          filters={[{
            key: "status", label: "Status",
            options: ["DRAFT", "SENT", "APPROVED", "REJECTED", "EXPIRED", "CONVERTED"].map((s) => ({ value: s, label: s.replaceAll("_", " ") })),
            match: (r, v) => r.status === v,
          }]}
          exportName="quotations"
          emptyTitle="No quotations match"
        />
      )}
    </div>
  );
}
