"use client";

// MOHD.HMS ENTERPRISE — Customer Detail (dedicated full page, /customers/{id}).
// Replaces the former detail dialog. In-page TABS (no popups): Overview,
// Equipment, Complaints, Work Orders, Quotations, Invoices — each tab is a
// lazy-loaded list that links to the record's dedicated page via the hash
// router. Tabs the signed-in user has no read permission for are hidden.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { StatCard, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate, fmtDateTime, money } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Pencil } from "lucide-react";

// ── Types ──

type CustomerDetail = {
  id: string; code: string; companyName: string; contactPerson: string;
  email: string; phone: string; address: string; city: string; country: string; status: string; notes: string;
  createdAt: string;
  portalUser: { id: string; email: string; name: string; status: string } | null;
  _count: { equipment: number; complaints: number; invoices: number; workOrders: number; quotations: number; payments: number };
};

type EquipmentRow = { id: string; assetTag: string; name: string; category: string; status: string };
type ComplaintRow = { id: string; code: string; title: string; status: string; priority: string; createdAt: string };
type WorkOrderRow = { id: string; code: string; title: string; status: string; scheduledDate: string | null };
type QuotationRow = { id: string; code: string; quotationDate: string; status: string; totalCents: number };
type InvoiceRow = { id: string; code: string; invoiceDate: string; status: string; totalCents: number; paidCents: number };

// ── Generic lazy tab list (Loading / Empty / Error / Success) ──

function TabResourceList<T>({ load, row, emptyTitle, emptyHint }: {
  load: () => Promise<T[]>;
  row: (item: T) => ReactNode;
  emptyTitle: string;
  emptyHint: string;
}) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setError(null);
      try {
        const d = await load();
        if (!cancelled) setRows(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this list.");
      }
    }
    run();
    return () => { cancelled = true; };
  }, [load, tick]);

  if (rows === null && error) return <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />;
  if (rows === null) return <LoadingState label="Loading…" rows={5} />;
  if (rows.length === 0) return <EmptyState title={emptyTitle} hint={emptyHint} />;
  return (
    <div className="divide-y rounded-lg border">
      {rows.map((item) => (
        <div key={(item as { id?: string }).id ?? JSON.stringify(item)}>{row(item)}</div>
      ))}
    </div>
  );
}

/** Row link shared by every tab — navigates to the record's dedicated page. */
function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="flex items-center gap-3 px-3 py-2 hover:bg-accent transition-colors text-sm">
      {children}
    </a>
  );
}

// ── Page ──

export function CustomerDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const canUpdate = hasPerm(user, PERMISSIONS.customers_update);
  const canReadEquipment = hasPerm(user, PERMISSIONS.equipment_read);
  const canReadComplaints = hasPerm(user, PERMISSIONS.complaints_read);
  const canReadWorkOrders = hasPerm(user, PERMISSIONS.work_orders_read);
  const canReadQuotations = hasPerm(user, PERMISSIONS.quotations_read);
  const canReadInvoices = hasPerm(user, PERMISSIONS.invoices_read);

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

  // Stable per-customer loaders for the lazy tabs.
  const loadEquipment = useCallback(
    () => api.get<EquipmentRow[]>(`/api/v1/equipment${qs({ customerId: id, pageSize: 200 })}`).then((r) => r.data),
    [id]
  );
  const loadComplaints = useCallback(
    () => api.get<ComplaintRow[]>(`/api/v1/complaints${qs({ customerId: id, pageSize: 200 })}`).then((r) => r.data),
    [id]
  );
  const loadWorkOrders = useCallback(
    () => api.get<WorkOrderRow[]>(`/api/v1/work-orders${qs({ customerId: id, pageSize: 200 })}`).then((r) => r.data),
    [id]
  );
  const loadQuotations = useCallback(
    () => api.get<QuotationRow[]>(`/api/v1/quotations${qs({ customerId: id, pageSize: 200 })}`).then((r) => r.data),
    [id]
  );
  const loadInvoices = useCallback(
    () => api.get<InvoiceRow[]>(`/api/v1/invoices${qs({ customerId: id, pageSize: 200 })}`).then((r) => r.data),
    [id]
  );

  if (loading && !detail) {
    return (
      <PageShell backLabel="Back to Customers" backHref="/customers" title="Customer details">
        <LoadingState label="Loading customer…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !detail) {
    return (
      <PageShell backLabel="Back to Customers" backHref="/customers" title="Customer details">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!detail) {
    return (
      <PageShell backLabel="Back to Customers" backHref="/customers" title="Customer details">
        <EmptyState title="Customer not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Customers"
      backHref="/customers"
      crumbs={[{ label: "Customers", href: "/customers" }, { label: detail.companyName }]}
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
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {canReadEquipment ? <TabsTrigger value="equipment">Equipment ({detail._count.equipment})</TabsTrigger> : null}
          {canReadComplaints ? <TabsTrigger value="complaints">Complaints ({detail._count.complaints})</TabsTrigger> : null}
          {canReadWorkOrders ? <TabsTrigger value="work-orders">Work Orders ({detail._count.workOrders})</TabsTrigger> : null}
          {canReadQuotations ? <TabsTrigger value="quotations">Quotations ({detail._count.quotations})</TabsTrigger> : null}
          {canReadInvoices ? <TabsTrigger value="invoices">Invoices ({detail._count.invoices})</TabsTrigger> : null}
        </TabsList>

        {/* ── Overview ── */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard title="Equipment" value={detail._count.equipment} />
            <StatCard title="Complaints" value={detail._count.complaints} />
            <StatCard title="Work orders" value={detail._count.workOrders} />
          </div>

          <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Address</p>
                <p>{[detail.address, detail.city, detail.country].filter(Boolean).join(", ") || "—"}</p>
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
        </TabsContent>

        {/* ── Equipment ── */}
        {canReadEquipment ? (
          <TabsContent value="equipment">
            <TabResourceList<EquipmentRow>
              load={loadEquipment}
              emptyTitle="No equipment registered"
              emptyHint="Units installed for this customer will appear here."
              row={(eq) => (
                <RowLink href={`/equipment/${encodeURIComponent(eq.id)}`}>
                  <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{eq.assetTag}</span>
                  <span className="flex-1 min-w-0 truncate">{eq.name}</span>
                  <span className="hidden sm:inline text-xs text-muted-foreground">{eq.category}</span>
                  <StatusBadge status={eq.status} />
                </RowLink>
              )}
            />
          </TabsContent>
        ) : null}

        {/* ── Complaints ── */}
        {canReadComplaints ? (
          <TabsContent value="complaints">
            <TabResourceList<ComplaintRow>
              load={loadComplaints}
              emptyTitle="No complaints logged"
              emptyHint="Complaints for this customer will appear here."
              row={(c) => (
                <RowLink href={`/complaints/${encodeURIComponent(c.id)}`}>
                  <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{c.code}</span>
                  <span className="flex-1 min-w-0 truncate">{c.title}</span>
                  <StatusBadge status={c.priority} />
                  <StatusBadge status={c.status} />
                </RowLink>
              )}
            />
          </TabsContent>
        ) : null}

        {/* ── Work Orders ── */}
        {canReadWorkOrders ? (
          <TabsContent value="work-orders">
            <TabResourceList<WorkOrderRow>
              load={loadWorkOrders}
              emptyTitle="No work orders"
              emptyHint="Work orders raised for this customer will appear here."
              row={(w) => (
                <RowLink href={`/work-orders/${encodeURIComponent(w.id)}`}>
                  <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{w.code}</span>
                  <span className="flex-1 min-w-0 truncate">{w.title}</span>
                  {w.scheduledDate ? <span className="hidden sm:inline text-xs text-muted-foreground">{fmtDate(w.scheduledDate)}</span> : null}
                  <StatusBadge status={w.status} />
                </RowLink>
              )}
            />
          </TabsContent>
        ) : null}

        {/* ── Quotations ── */}
        {canReadQuotations ? (
          <TabsContent value="quotations">
            <TabResourceList<QuotationRow>
              load={loadQuotations}
              emptyTitle="No quotations"
              emptyHint="Quotations prepared for this customer will appear here."
              row={(q) => (
                <RowLink href={`/quotations/${encodeURIComponent(q.id)}`}>
                  <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{q.code}</span>
                  <span className="flex-1 min-w-0 truncate">{fmtDate(q.quotationDate)}</span>
                  <span className="text-xs">{money(q.totalCents)}</span>
                  <StatusBadge status={q.status} />
                </RowLink>
              )}
            />
          </TabsContent>
        ) : null}

        {/* ── Invoices ── */}
        {canReadInvoices ? (
          <TabsContent value="invoices">
            <TabResourceList<InvoiceRow>
              load={loadInvoices}
              emptyTitle="No invoices issued"
              emptyHint="Invoices for this customer will appear here."
              row={(inv) => (
                <RowLink href={`/invoices/${encodeURIComponent(inv.id)}`}>
                  <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{inv.code}</span>
                  <span className="flex-1 min-w-0 truncate">{fmtDateTime(inv.invoiceDate)}</span>
                  <span className="text-xs">{money(inv.totalCents)} <span className="text-muted-foreground">({money(inv.paidCents)} paid)</span></span>
                  <StatusBadge status={inv.status} />
                </RowLink>
              )}
            />
          </TabsContent>
        ) : null}
      </Tabs>
    </PageShell>
  );
}
