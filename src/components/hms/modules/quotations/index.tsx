"use client";

// MOHD.HMS ENTERPRISE — Quotations module (agent 6-e)
// List + stats + create dialog (draft-protected) + document preview with workflow
// actions + convert-to-invoice + print + CSV export. All figures come from the API.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { useSession, hasPerm } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { money, fmtDate, fromCents } from "@/lib/hms/format";
import { PERMISSIONS } from "@/lib/hms/constants";
import { FileText, Plus, Printer, Send, Check, X, Clock, Repeat, Trash2, RotateCcw } from "lucide-react";

// ── Types (mirror API responses) ──

type CustomerLite = { id: string; code: string; companyName: string; contactPerson?: string; email?: string; phone?: string };

type QuotationRow = {
  id: string; code: string; status: string;
  quotationDate: string; validUntil: string | null;
  subtotalCents: number; discountCents: number; taxCents: number; shippingCents: number; totalCents: number;
  customer: CustomerLite;
};

type QuotationItemRow = {
  id: string; kind: string; description: string; quantity: number; unit: string;
  unitPriceCents: number; discountPercent: number; taxPercent: number; totalCents: number;
};

type QuotationDetail = QuotationRow & {
  notes: string; terms: string; labourCostCents: number; materialCostCents: number;
  convertedInvoiceId: string | null;
  items: QuotationItemRow[];
};

type InventoryLite = { id: string; sku: string; name: string; unit: string; unitCostCents: number };

type FormItem = {
  kind: string; itemId: string; description: string; quantity: string; unit: string;
  unitPrice: string; discountPercent: string; taxPercent: string;
};

type QForm = {
  customerId: string; validUntil: string; discount: string; shipping: string;
  notes: string; terms: string; items: FormItem[];
};

const KINDS = ["MATERIAL", "LABOUR", "SERVICE", "CUSTOM"] as const;
const FALLBACK_COMPANY = "MOHD.HMS Enterprise";

const emptyItem = (): FormItem => ({ kind: "MATERIAL", itemId: "", description: "", quantity: "1", unit: "pcs", unitPrice: "", discountPercent: "0", taxPercent: "0" });
const emptyForm = (): QForm => ({ customerId: "", validUntil: "", discount: "0", shipping: "0", notes: "", terms: "", items: [emptyItem()] });

// ── Client-side math — mirrors the server exactly ──

function lineTotalCents(quantity: string, unitPrice: string, discountPercent: string): number {
  const qty = parseFloat(quantity) || 0;
  const cents = Math.round((parseFloat(unitPrice) || 0) * 100);
  const disc = parseFloat(discountPercent) || 0;
  return Math.round(qty * cents * (1 - disc / 100));
}

function formTotals(items: FormItem[], discount: string, shipping: string) {
  const subtotalCents = items.reduce((s, it) => s + lineTotalCents(it.quantity, it.unitPrice, it.discountPercent), 0);
  const taxCents = items.reduce((s, it) => s + Math.round((lineTotalCents(it.quantity, it.unitPrice, it.discountPercent) * (parseFloat(it.taxPercent) || 0)) / 100), 0);
  const discountCents = Math.round((parseFloat(discount) || 0) * 100);
  const shippingCents = Math.round((parseFloat(shipping) || 0) * 100);
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents + shippingCents);
  return { subtotalCents, taxCents, discountCents, shippingCents, totalCents };
}

/** Resolve the company label from /api/v1/settings with a graceful fallback. */
async function loadCompanyName(): Promise<string> {
  try {
    const res = await api.get<unknown>("/api/v1/settings");
    const d = res.data;
    if (Array.isArray(d)) {
      const row = d.find((r) => (r as { key?: string })?.key === "company_name") as { value?: string } | undefined;
      if (row?.value) return row.value;
    } else if (d && typeof d === "object") {
      const obj = d as Record<string, unknown>;
      if (typeof obj.company_name === "string") return obj.company_name;
      if (obj.company && typeof obj.company === "object" && typeof (obj.company as Record<string, unknown>).name === "string") {
        return String((obj.company as Record<string, unknown>).name);
      }
    }
  } catch {
    /* settings API not available yet — fallback label */
  }
  return FALLBACK_COMPANY;
}

// ── Document preview (screen dialog + print-only container) ──

function DocumentPreview({ q, company }: { q: QuotationDetail; company: string }) {
  return (
    <div className="text-sm">
      <div className="flex flex-col sm:flex-row justify-between gap-4 pb-4">
        <div>
          <div className="text-base font-semibold text-primary">{company}</div>
          <div className="text-xs text-muted-foreground mt-1">Facility Maintenance &amp; Engineering Services</div>
        </div>
        <div className="sm:text-right">
          <div className="text-lg font-semibold">QUOTATION</div>
          <div className="text-xs text-muted-foreground">{q.code}</div>
          <div className="text-xs text-muted-foreground mt-1">Date: {fmtDate(q.quotationDate)}</div>
          <div className="text-xs text-muted-foreground">Valid until: {fmtDate(q.validUntil)}</div>
        </div>
      </div>
      <Separator className="mb-4" />
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Bill to</div>
        <div className="font-medium">{q.customer?.companyName}</div>
        {q.customer?.contactPerson ? <div className="text-xs text-muted-foreground">{q.customer.contactPerson}</div> : null}
        {q.customer?.email ? <div className="text-xs text-muted-foreground">{q.customer.email}</div> : null}
        {q.customer?.phone ? <div className="text-xs text-muted-foreground">{q.customer.phone}</div> : null}
      </div>
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th className="px-2 py-2 font-medium">Description</th>
              <th className="px-2 py-2 font-medium text-right">Qty</th>
              <th className="px-2 py-2 font-medium hidden sm:table-cell">Unit</th>
              <th className="px-2 py-2 font-medium text-right">Unit price</th>
              <th className="px-2 py-2 font-medium text-right hidden sm:table-cell">Disc %</th>
              <th className="px-2 py-2 font-medium text-right hidden sm:table-cell">Tax %</th>
              <th className="px-2 py-2 font-medium text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {q.items.map((it) => (
              <tr key={it.id} className="border-b last:border-0">
                <td className="px-2 py-2">
                  <div className="font-medium">{it.description}</div>
                  <div className="text-muted-foreground">{it.kind}</div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{it.quantity}</td>
                <td className="px-2 py-2 hidden sm:table-cell">{it.unit}</td>
                <td className="px-2 py-2 text-right tabular-nums">{money(it.unitPriceCents)}</td>
                <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">{it.discountPercent}%</td>
                <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">{it.taxPercent}%</td>
                <td className="px-2 py-2 text-right tabular-nums">{money(it.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end">
        <div className="w-full sm:w-64 space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{money(q.subtotalCents)}</span></div>
          {q.discountCents > 0 ? <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular-nums">-{money(q.discountCents)}</span></div> : null}
          <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{money(q.taxCents)}</span></div>
          {q.shippingCents > 0 ? <div className="flex justify-between"><span className="text-muted-foreground">Shipping</span><span className="tabular-nums">{money(q.shippingCents)}</span></div> : null}
          <Separator />
          <div className="flex justify-between text-sm font-semibold"><span>Total</span><span className="tabular-nums">{money(q.totalCents)}</span></div>
        </div>
      </div>
      {q.notes ? <div className="mt-4 text-xs"><span className="font-medium">Notes: </span><span className="text-muted-foreground whitespace-pre-line">{q.notes}</span></div> : null}
      {q.terms ? <div className="mt-2 text-xs"><span className="font-medium">Terms: </span><span className="text-muted-foreground whitespace-pre-line">{q.terms}</span></div> : null}
    </div>
  );
}

// ── Main module ──

export function QuotationsModule() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.quotations_manage);

  const [rows, setRows] = useState<QuotationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detail, setDetail] = useState<QuotationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [company, setCompany] = useState(FALLBACK_COMPANY);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [inventory, setInventory] = useState<InventoryLite[]>([]);
  const [refsLoading, setRefsLoading] = useState(false);

  const form = useDraft<QForm>({ formKey: "quotation.create", initial: emptyForm() });

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

  // Company label for document previews (best-effort)
  useEffect(() => { loadCompanyName().then(setCompany); }, []);

  // Load select references when the create dialog is opened by a user who can manage
  useEffect(() => {
    if (!createOpen || !canManage || customers.length > 0) return;
    setRefsLoading(true);
    Promise.all([
      api.get<CustomerLite[]>("/api/v1/customers").catch(() => null),
      api.get<InventoryLite[]>("/api/v1/inventory").catch(() => null),
    ]).then(([c, i]) => {
      if (c) setCustomers(c.data);
      if (i) setInventory(i.data);
      if (!c) toast({ title: "Customers unavailable", description: "Could not load the customer list. Please retry later.", variant: "destructive" });
    }).finally(() => setRefsLoading(false));
  }, [createOpen, canManage, customers.length, toast]);

  async function openDetail(id: string) {
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const res = await api.get<QuotationDetail>(`/api/v1/quotations/${id}`);
      setDetail(res.data);
    } catch (e) {
      toast({ title: "Unable to load quotation", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }

  async function transition(id: string, action: "send" | "approve" | "reject" | "expire") {
    setBusy(true);
    try {
      const res = await api.post<QuotationRow>(`/api/v1/quotations/${id}/transition`, { action });
      toast({ title: `Quotation ${res.data.code} ${action === "send" ? "sent" : action + "ed"}`, description: `Status: ${res.data.status.replaceAll("_", " ").toLowerCase()}` });
      await Promise.all([load(), openDetail(id)]);
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function convert(id: string) {
    setBusy(true);
    try {
      const res = await api.post<{ id: string; code: string }>(`/api/v1/quotations/${id}/convert`);
      toast({ title: "Invoice created", description: `Quotation converted to invoice ${res.data.code} (draft).` });
      await Promise.all([load(), openDetail(id)]);
    } catch (e) {
      toast({ title: "Conversion failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function removeDraft(id: string) {
    if (!window.confirm("Delete this draft quotation permanently?")) return;
    setBusy(true);
    try {
      await api.del(`/api/v1/quotations/${id}`);
      toast({ title: "Draft quotation deleted" });
      setDetailOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function createQuotation() {
    if (!form.value.customerId) {
      toast({ title: "Customer required", description: "Select a customer for this quotation.", variant: "destructive" });
      return;
    }
    const validItems = form.value.items.filter((it) => it.description.trim() && (parseFloat(it.unitPrice) || 0) >= 0 && (parseFloat(it.quantity) || 0) > 0);
    if (validItems.length === 0) {
      toast({ title: "Line items required", description: "Add at least one item with a description and price.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<QuotationDetail>("/api/v1/quotations", {
        customerId: form.value.customerId,
        validUntil: form.value.validUntil || null,
        discount: parseFloat(form.value.discount) || 0,
        shipping: parseFloat(form.value.shipping) || 0,
        notes: form.value.notes,
        terms: form.value.terms,
        items: validItems.map((it) => ({
          kind: it.kind,
          itemId: it.itemId || null,
          description: it.description.trim(),
          quantity: parseFloat(it.quantity) || 0,
          unit: it.unit || undefined,
          unitPrice: parseFloat(it.unitPrice) || 0,
          discountPercent: parseFloat(it.discountPercent) || 0,
          taxPercent: parseFloat(it.taxPercent) || 0,
        })),
      });
      toast({ title: `Quotation ${res.data.code} created`, description: `Total ${money(res.data.totalCents)} — draft status.` });
      form.reset(emptyForm());
      setCreateOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Could not create quotation", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  function setItem(index: number, patch: Partial<FormItem>) {
    const items = form.value.items.map((it, i) => (i === index ? { ...it, ...patch } : it));
    form.setValue({ items });
  }

  function pickInventory(index: number, itemId: string) {
    const item = inventory.find((i) => i.id === itemId);
    if (!item) { setItem(index, { itemId: "" }); return; }
    setItem(index, { itemId, description: item.name, unit: item.unit, unitPrice: fromCents(item.unitCostCents) });
  }

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
      {/* Screen content — hidden in print */}
      <div className="print:hidden">
        <PageHeader
          title="Quotations"
          subtitle="Prepare, send and convert customer quotations"
          actions={canManage ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
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
            action={canManage ? <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> New Quotation</Button> : undefined}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => openDetail(r.id)}
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

      {/* Print-only document */}
      {detail ? (
        <div className="hidden print:block">
          <DocumentPreview q={detail} company={company} />
        </div>
      ) : null}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Quotation</DialogTitle>
            <DialogDescription>
              Totals are computed server-side from the line items below.
              {form.dirty ? " Draft auto-saved locally." : ""}
            </DialogDescription>
          </DialogHeader>

          {form.draftExists ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
              <FileText className="h-4 w-4 text-amber-600 shrink-0" />
              <span className="flex-1">An unsent draft exists from a previous session.</span>
              <Button size="sm" variant="outline" onClick={form.restore}><RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore</Button>
              <Button size="sm" variant="ghost" onClick={form.discard}>Discard</Button>
            </div>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Customer *</Label>
              <Select value={form.value.customerId} onValueChange={(v) => form.setValue({ customerId: v })}>
                <SelectTrigger aria-label="Customer"><SelectValue placeholder={refsLoading ? "Loading customers…" : "Select customer"} /></SelectTrigger>
                <SelectContent>
                  {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.companyName} ({c.code})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Valid until</Label>
              <Input type="date" value={form.value.validUntil} onChange={(e) => form.setValue({ validUntil: e.target.value })} />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Line items *</Label>
              <Button type="button" size="sm" variant="outline" onClick={() => form.setValue({ items: [...form.value.items, emptyItem()] })}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add item
              </Button>
            </div>
            {form.value.items.map((it, idx) => (
              <div key={idx} className="rounded-lg border p-3 space-y-2">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Select value={it.kind} onValueChange={(v) => setItem(idx, { kind: v })}>
                    <SelectTrigger aria-label="Kind"><SelectValue /></SelectTrigger>
                    <SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
                  </Select>
                  <Select value={it.itemId || "CUSTOM"} onValueChange={(v) => pickInventory(idx, v === "CUSTOM" ? "" : v)}>
                    <SelectTrigger aria-label="Inventory item" className="sm:col-span-3">
                      <SelectValue placeholder="Custom line — or pick from inventory" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CUSTOM">Custom line</SelectItem>
                      {inventory.map((inv) => <SelectItem key={inv.id} value={inv.id}>{inv.name} · {inv.sku}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <Input placeholder="Description" value={it.description} onChange={(e) => setItem(idx, { description: e.target.value })} aria-label="Description" />
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Qty</Label><Input inputMode="decimal" value={it.quantity} onChange={(e) => setItem(idx, { quantity: e.target.value })} /></div>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Unit</Label><Input value={it.unit} onChange={(e) => setItem(idx, { unit: e.target.value })} /></div>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Price RM</Label><Input inputMode="decimal" value={it.unitPrice} onChange={(e) => setItem(idx, { unitPrice: e.target.value })} placeholder="0.00" /></div>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Disc %</Label><Input inputMode="decimal" value={it.discountPercent} onChange={(e) => setItem(idx, { discountPercent: e.target.value })} /></div>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Tax %</Label><Input inputMode="decimal" value={it.taxPercent} onChange={(e) => setItem(idx, { taxPercent: e.target.value })} /></div>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-red-600 hover:text-red-700 hover:bg-red-50"
                    disabled={form.value.items.length === 1}
                    onClick={() => form.setValue({ items: form.value.items.filter((_, i) => i !== idx) })}>
                    <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
                  </Button>
                  <span>Line total: <strong className="text-foreground tabular-nums">{money(lineTotalCents(it.quantity, it.unitPrice, it.discountPercent))}</strong></span>
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5"><Label>Discount (RM)</Label><Input inputMode="decimal" value={form.value.discount} onChange={(e) => form.setValue({ discount: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Shipping (RM)</Label><Input inputMode="decimal" value={form.value.shipping} onChange={(e) => form.setValue({ shipping: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5"><Label>Notes</Label><Textarea rows={2} value={form.value.notes} onChange={(e) => form.setValue({ notes: e.target.value })} placeholder="Internal or customer notes" /></div>
            <div className="space-y-1.5"><Label>Terms</Label><Textarea rows={2} value={form.value.terms} onChange={(e) => form.setValue({ terms: e.target.value })} placeholder="Payment / validity terms" /></div>
          </div>

          {(() => {
            const t = formTotals(form.value.items, form.value.discount, form.value.shipping);
            return (
              <div className="rounded-lg bg-muted/50 border p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{money(t.subtotalCents)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular-nums">-{money(t.discountCents)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{money(t.taxCents)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Shipping</span><span className="tabular-nums">{money(t.shippingCents)}</span></div>
                <Separator />
                <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">{money(t.totalCents)}</span></div>
              </div>
            );
          })()}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createQuotation} disabled={busy || refsLoading}>
              {busy ? "Saving…" : "Create quotation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto print:hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Quotation {detail?.code ?? ""}
              {detail ? <StatusBadge status={detail.status} /> : null}
            </DialogTitle>
            <DialogDescription>Document preview and workflow actions</DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <LoadingState label="Loading quotation…" rows={2} />
          ) : (
            <>
              <DocumentPreview q={detail} company={company} />

              <div className="flex flex-wrap gap-2 pt-2 no-print">
                {canManage && detail.status === "DRAFT" ? (
                  <Button size="sm" disabled={busy} onClick={() => transition(detail.id, "send")}>
                    <Send className="h-4 w-4 mr-1.5" /> Send to customer
                  </Button>
                ) : null}
                {canManage && detail.status === "SENT" ? (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => transition(detail.id, "approve")}>
                      <Check className="h-4 w-4 mr-1.5" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => transition(detail.id, "reject")}>
                      <X className="h-4 w-4 mr-1.5" /> Reject
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => transition(detail.id, "expire")}>
                      <Clock className="h-4 w-4 mr-1.5" /> Mark expired
                    </Button>
                  </>
                ) : null}
                {canManage && detail.status === "APPROVED" ? (
                  <Button size="sm" disabled={busy} onClick={() => convert(detail.id)}>
                    <Repeat className="h-4 w-4 mr-1.5" /> Convert to Invoice
                  </Button>
                ) : null}
                {canManage && detail.status === "DRAFT" ? (
                  <Button size="sm" variant="outline" className="text-red-600 hover:bg-red-50" disabled={busy} onClick={() => removeDraft(detail.id)}>
                    <Trash2 className="h-4 w-4 mr-1.5" /> Delete draft
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => window.print()}>
                  <Printer className="h-4 w-4 mr-1.5" /> Print
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
