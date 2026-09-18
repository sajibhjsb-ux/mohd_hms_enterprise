"use client";

// MOHD.HMS ENTERPRISE — Customer Detail (dedicated full page, #/customers/{id}).
// Replaces the former detail dialog: same data, same API (GET /api/v1/customers/{id}).
// Recent complaints link to their complaint pages, recent invoices to the
// invoice pages — cross-module navigation flows through the hash router.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { StatCard, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate, money } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";

// ── Types ──

type CustomerDetail = {
  id: string; code: string; companyName: string; contactPerson: string;
  email: string; phone: string; address: string; city: string; status: string; notes: string;
  createdAt: string;
  portalUser: { id: string; email: string; name: string; status: string } | null;
  _count: { equipment: number; complaints: number; invoices: number; workOrders: number; quotations: number; payments: number };
  complaints: { id: string; code: string; title: string; status: string; priority: string; createdAt: string }[];
  invoices: { id: string; code: string; totalCents: number; paidCents: number; status: string; invoiceDate: string }[];
};

// ── Page ──

export function CustomerDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const canUpdate = hasPerm(user, PERMISSIONS.customers_update);

  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<CustomerDetail>(`/api/v1/customers/${id}`);
      setDetail(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this customer.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading && !detail) {
    return (
      <PageShell backLabel="Back to Customers" backHref="#/customers" title="Customer details">
        <LoadingState label="Loading customer…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !detail) {
    return (
      <PageShell backLabel="Back to Customers" backHref="#/customers" title="Customer details">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!detail) {
    return (
      <PageShell backLabel="Back to Customers" backHref="#/customers" title="Customer details">
        <EmptyState title="Customer not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Customers"
      backHref="#/customers"
      crumbs={[{ label: "Customers", href: "#/customers" }, { label: detail.companyName }]}
      title={detail.companyName}
      description={`${detail.code} · ${detail.contactPerson} · ${detail.email} · ${detail.phone}`}
      actions={
        <div className="flex items-center gap-2">
          <StatusBadge status={detail.status} />
          {canUpdate ? (
            <Button variant="outline" onClick={() => navigateTo("customers", [detail.id, "edit"])}>
              <Pencil className="h-4 w-4 mr-1.5" /> Edit
            </Button>
          ) : null}
        </div>
      }
    >
      {/* Engagement stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard title="Equipment" value={detail._count.equipment} />
        <StatCard title="Complaints" value={detail._count.complaints} />
        <StatCard title="Work orders" value={detail._count.workOrders} />
      </div>

      {/* Record information */}
      <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Address</p>
            <p>{[detail.address, detail.city].filter(Boolean).join(", ") || "—"}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Portal account</p>
            <p className="flex items-center gap-2">
              {detail.portalUser ? (
                <>
                  <StatusBadge status={detail.portalUser.status} />
                  <span className="truncate">{detail.portalUser.email}</span>
                </>
              ) : "No portal user"}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Quotations / Invoices</p>
            <p>{detail._count.quotations} / {detail._count.invoices}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Customer since</p>
            <p>{fmtDate(detail.createdAt)}</p>
          </div>
        </div>
        {detail.notes ? (
          <div className="mt-4 space-y-1 text-sm">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Notes</p>
            <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3">{detail.notes}</p>
          </div>
        ) : null}
      </div>

      {/* Recent complaints → complaint detail pages */}
      <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5">
        <p className="text-sm font-medium mb-2">Recent complaints</p>
        {detail.complaints.length === 0 ? (
          <p className="text-sm text-muted-foreground">No complaints logged.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {detail.complaints.map((c) => (
              <a
                key={c.id}
                href={`#/complaints/${encodeURIComponent(c.id)}`}
                className="flex items-center gap-3 px-3 py-2 hover:bg-accent transition-colors"
              >
                <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{c.code}</span>
                <span className="flex-1 min-w-0 truncate text-sm">{c.title}</span>
                <StatusBadge status={c.priority} />
                <StatusBadge status={c.status} />
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Recent invoices → invoice detail pages */}
      <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5">
        <p className="text-sm font-medium mb-2">Recent invoices</p>
        {detail.invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices issued.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {detail.invoices.map((inv) => (
              <a
                key={inv.id}
                href={`#/invoices/${encodeURIComponent(inv.id)}`}
                className="flex items-center gap-3 px-3 py-2 hover:bg-accent transition-colors"
              >
                <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{inv.code}</span>
                <span className="flex-1 text-sm">{money(inv.totalCents)} <span className="text-muted-foreground">({money(inv.paidCents)} paid)</span></span>
                <StatusBadge status={inv.status} />
              </a>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
