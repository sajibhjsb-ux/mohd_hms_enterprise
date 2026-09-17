"use client";

// MOHD.HMS ENTERPRISE — Invoices module (agent 6-e)
// List + KPIs from API meta + create (manual items or from completed work order) +
// document preview + payments (record payment workflow) + print + CSV export.

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
import { Receipt, Plus, Printer, Send, Wallet, TriangleAlert, Ban, Trash2, RotateCcw, CircleDollarSign } from "lucide-react";

// ── Types (mirror API responses) ──

type CustomerLite = { id: string; code: string; companyName: string; contactPerson?: string; email?: string; phone?: string };

type PaymentRow = {
  id: string; code: string; amountCents: number; method: string; reference: string;
  paidAt: string; note: string;
};

type InvoiceRow = {
  id: string; code: string; status: string;
  invoiceDate: string; dueDate: string | null;
  subtotalCents: number; discountCents: number; taxCents: number; shippingCents: number;
  totalCents: number; paidCents: number; balanceCents: number;
  customer: CustomerLite;
};

type InvoiceItemRow = {
  id: string; kind: string; description: string; quantity: number; unit: string;
  unitPriceCents: number; discountPercent: number; taxPercent: number; totalCents: number;
};

type InvoiceDetail = InvoiceRow & {
  notes: string; terms: string; sentAt: string | null;
  items: InvoiceItemRow[];
  payments: PaymentRow[];
  quotation: { id: string; code: string } | null;
  workOrders: { id: string; code: string; title: string }[];
};

type InventoryLite = { id: string; sku: string; name: string; unit: string; unitCostCents: number };
type WoLite = { id: string; code: string; title: string; customer?: { companyName: string } | null };

type FormItem = {
  kind: string; itemId: string; description: string; quantity: string; unit: string;
  unitPrice: string; discountPercent: string; taxPercent: string;
};

type IForm = {
  customerId: string; dueDate: string; discount: string; shipping: string;
  notes: string; terms: string; items: FormItem[];
};

const KINDS = ["MATERIAL", "LABOUR", "SERVICE", "CUSTOM"] as const;
const METHODS = ["CASH", "BANK_TRANSFER", "CARD", "CHEQUE", "ONLINE"] as const;
const FALLBACK_COMPANY = "MOHD.HMS Enterprise";

const emptyItem = (): FormItem => ({ kind: "MATERIAL", itemId: "", description: "", quantity: "1", unit: "pcs", unitPrice: "", discountPercent: "0", taxPercent: "0" });
const emptyForm = (): IForm => ({ customerId: "", dueDate: "", discount: "0", shipping: "0", notes: "", terms: "", items: [emptyItem()] });

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

// ── Invoice document preview ──

function DocumentPreview({ inv, company }: { inv: InvoiceDetail; company: string }) {
  return (
    <div className="text-sm">
      <div className="flex flex-col sm:flex-row justify-between gap-4 pb-4">
        <div>
          <div className="text-base font-semibold text-primary">{company}</div>
          <div className="text-xs text-muted-foreground mt-1">Facility Maintenance &amp; Engineering Services</div>
        </div>
        <div className="sm:text-right">
          <div className="text-lg font-semibold">INVOICE</div>
          <div className="text-xs text-muted-foreground">{inv.code}</div>
          <div className="text-xs text-muted-foreground mt-1">Invoice date: {fmtDate(inv.invoiceDate)}</div>
          <div className="text-xs text-muted-foreground">Due date: {fmtDate(inv.dueDate)}</div>
        </div>
      </div>
      <Separator className="mb-4" />
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Bill to</div>
        <div className="font-medium">{inv.customer?.companyName}</div>
        {inv.customer?.contactPerson ? <div className="text-xs text-muted-foreground">{inv.customer.contactPerson}</div> : null}
        {inv.customer?.email ? <div className="text-xs text-muted-foreground">{inv.customer.email}</div> : null}
        {inv.customer?.phone ? <div className="text-xs text-muted-foreground">{inv.customer.phone}</div> : null}
      </div>
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th className="px-2 py-2 font-medium">Description</th>
              <th className="px-2 py-2 font-medium text-right">Qty</th>
              <th className="px-2 py-2 font-medium hidden sm:table-cell">Unit</th>
              <th className="px-2 py-2 font-medium text-right">Unit price</th>
              <th className="px-2 py-2 font-medium text-right hidden sm:table-cell">Tax %</th>
              <th className="px-2 py-2 font-medium text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.items.map((it) => (
              <tr key={it.id} className="border-b last:border-0">
                <td className="px-2 py-2">
                  <div className="font-medium">{it.description}</div>
                  <div className="text-muted-foreground">{it.kind}</div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{it.quantity}</td>
                <td className="px-2 py-2 hidden sm:table-cell">{it.unit}</td>
                <td className="px-2 py-2 text-right tabular-nums">{money(it.unitPriceCents)}</td>
                <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">{it.taxPercent}%</td>
                <td className="px-2 py-2 text-right tabular-nums">{money(it.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end">
        <div className="w-full sm:w-64 space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{money(inv.subtotalCents)}</span></div>
          {inv.discountCents > 0 ? <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular-nums">-{money(inv.discountCents)}</span></div> : null}
          <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{money(inv.taxCents)}</span></div>
          {inv.shippingCents > 0 ? <div className="flex justify-between"><span className="text-muted-foreground">Shipping</span><span className="tabular-nums">{money(inv.shippingCents)}</span></div> : null}
          <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span className="tabular-nums text-emerald-700">-{money(inv.paidCents)}</span></div>
          <Separator />
          <div className="flex justify-between text-sm font-semibold"><span>Balance due</span><span className="tabular-nums">{money(inv.balanceCents)}</span></div>
          <div className="flex justify-between text-muted-foreground"><span>Total</span><span className="tabular-nums">{money(inv.totalCents)}</span></div>
        </div>
      </div>
      {inv.notes ? <div className="mt-4 text-xs"><span className="font-medium">Notes: </span><span className="text-muted-foreground whitespace-pre-line">{inv.notes}</span></div> : null}
      {inv.terms ? <div className="mt-2 text-xs"><span className="font-medium">Terms: </span><span className="text-muted-foreground whitespace-pre-line">{inv.terms}</span></div> : null}
    </div>
  );
}

// ── Main module ──

export function InvoicesModule() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.invoices_manage);
  const canRecord = hasPerm(user, PERMISSIONS.payments_record);

  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [meta, setMeta] = useState<{ outstandingCents: number; overdueCount: number; paidThisMonthCents: number }>({ outstandingCents: 0, overdueCount: 0, paidThisMonthCents: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [company, setCompany] = useState(FALLBACK_COMPANY);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [source, setSource] = useState<"manual" | "wo">("manual");
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [inventory, setInventory] = useState<InventoryLite[]>([]);
  const [wos, setWos] = useState<WoLite[]>([]);
  const [woState, setWoState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [woId, setWoId] = useState("");
  const [refsLoading, setRefsLoading] = useState(false);

  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<string>("BANK_TRANSFER");
  const [payReference, setPayReference] = useState("");
  const [payNote, setPayNote] = useState("");

  const form = useDraft<IForm>({ formKey: "invoice.create", initial: emptyForm() });

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
  useEffect(() => { loadCompanyName().then(setCompany); }, []);

  // References for the create dialog (completed WOs may 403 for some roles → hide option)
  useEffect(() => {
    if (!createOpen || !canManage || customers.length > 0) return;
    setRefsLoading(true);
    Promise.all([
      api.get<CustomerLite[]>("/api/v1/customers").catch(() => null),
      api.get<InventoryLite[]>("/api/v1/inventory").catch(() => null),
      api.get<WoLite[]>(`/api/v1/work-orders${qs({ status: "COMPLETED", pageSize: 100 })}`).then(
        (r) => { setWos(r.data); setWoState(r.data.length > 0 ? "ready" : "unavailable"); },
        () => setWoState("unavailable"),
      ),
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
      const res = await api.get<InvoiceDetail>(`/api/v1/invoices/${id}`);
      setDetail(res.data);
    } catch (e) {
      toast({ title: "Unable to load invoice", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }

  async function transition(id: string, action: "send" | "cancel") {
    setBusy(true);
    try {
      const res = await api.post<InvoiceRow>(`/api/v1/invoices/${id}/transition`, { action });
      toast({ title: action === "send" ? `Invoice ${res.data.code} sent` : `Invoice ${res.data.code} cancelled`, description: `Status: ${res.data.status.replaceAll("_", " ").toLowerCase()}` });
      await Promise.all([load(), openDetail(id)]);
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function removeDraft(id: string) {
    if (!window.confirm("Delete this draft invoice permanently?")) return;
    setBusy(true);
    try {
      await api.del(`/api/v1/invoices/${id}`);
      toast({ title: "Draft invoice deleted" });
      setDetailOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  function openPayDialog() {
    if (!detail) return;
    setPayAmount(fromCents(detail.balanceCents));
    setPayMethod("BANK_TRANSFER");
    setPayReference("");
    setPayNote("");
    setPayOpen(true);
  }

  async function recordPayment() {
    if (!detail) return;
    const amount = parseFloat(payAmount);
    if (!isFinite(amount) || amount <= 0) {
      toast({ title: "Invalid amount", description: "Enter a payment amount greater than 0.", variant: "destructive" });
      return;
    }
    if (Math.round(amount * 100) > detail.balanceCents) {
      toast({ title: "Amount exceeds balance", description: `Outstanding balance is ${money(detail.balanceCents)}.`, variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<InvoiceDetail>(`/api/v1/invoices/${detail.id}/payments`, {
        amount, method: payMethod, reference: payReference || undefined, note: payNote || undefined,
      });
      toast({ title: "Payment recorded", description: `Balance now ${money(res.data.balanceCents)} — status ${res.data.status.replaceAll("_", " ").toLowerCase()}.` });
      setPayOpen(false);
      await Promise.all([load(), openDetail(detail.id)]);
    } catch (e) {
      toast({ title: "Payment failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function createInvoice() {
    if (source === "wo") {
      if (!woId) {
        toast({ title: "Work order required", description: "Select a completed work order to invoice.", variant: "destructive" });
        return;
      }
      setBusy(true);
      try {
        const res = await api.post<InvoiceDetail>("/api/v1/invoices", {
          workOrderId: woId,
          dueDate: form.value.dueDate || undefined,
          notes: form.value.notes || undefined,
          terms: form.value.terms || undefined,
        });
        toast({ title: `Invoice ${res.data.code} created`, description: `Built from work order — total ${money(res.data.totalCents)} (draft).` });
        form.reset(emptyForm());
        setCreateOpen(false);
        await load();
      } catch (e) {
        toast({ title: "Could not create invoice", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!form.value.customerId) {
      toast({ title: "Customer required", description: "Select a customer for this invoice.", variant: "destructive" });
      return;
    }
    const validItems = form.value.items.filter((it) => it.description.trim() && (parseFloat(it.quantity) || 0) > 0);
    if (validItems.length === 0) {
      toast({ title: "Line items required", description: "Add at least one item with a description and quantity.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<InvoiceDetail>("/api/v1/invoices", {
        customerId: form.value.customerId,
        dueDate: form.value.dueDate || undefined,
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
      toast({ title: `Invoice ${res.data.code} created`, description: `Total ${money(res.data.totalCents)} — draft status.` });
      form.reset(emptyForm());
      setCreateOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Could not create invoice", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
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

  const payPreview = useMemo(() => {
    const amount = Math.round((parseFloat(payAmount) || 0) * 100);
    if (!detail || amount <= 0) return null;
    return {
      newBalanceCents: Math.max(0, detail.balanceCents - amount),
      newStatus: detail.balanceCents - amount === 0 ? "PAID" : "PARTIALLY_PAID",
    };
  }, [payAmount, detail]);

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
      <div className="print:hidden">
        <PageHeader
          title="Invoices"
          subtitle="Billing, payments and collections"
          actions={canManage ? (
            <Button size="sm" onClick={() => { setSource("manual"); setCreateOpen(true); }}>
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
            action={canManage ? <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> New Invoice</Button> : undefined}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => openDetail(r.id)}
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

      {/* Print-only document */}
      {detail ? (
        <div className="hidden print:block">
          <DocumentPreview inv={detail} company={company} />
        </div>
      ) : null}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Invoice</DialogTitle>
            <DialogDescription>
              {source === "manual" ? "Totals are computed server-side from the line items below." : "Items will be built from the work order's labour and materials."}
              {form.dirty && source === "manual" ? " Draft auto-saved locally." : ""}
            </DialogDescription>
          </DialogHeader>

          {woState === "ready" ? (
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={source} onValueChange={(v) => setSource(v as "manual" | "wo")}>
                <SelectTrigger aria-label="Invoice source"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual line items</SelectItem>
                  <SelectItem value="wo">From completed work order</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {source === "wo" ? (
            <div className="space-y-1.5">
              <Label>Completed work order *</Label>
              <Select value={woId} onValueChange={setWoId}>
                <SelectTrigger aria-label="Work order"><SelectValue placeholder={refsLoading || woState === "loading" ? "Loading work orders…" : "Select work order"} /></SelectTrigger>
                <SelectContent>
                  {wos.map((w) => <SelectItem key={w.id} value={w.id}>{w.code} — {w.title}{w.customer?.companyName ? ` (${w.customer.companyName})` : ""}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Labour (6% tax) and consumed materials (6% tax) become invoice lines.</p>
            </div>
          ) : null}

          {source === "manual" ? (
            <>
              {form.draftExists ? (
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                  <Receipt className="h-4 w-4 text-amber-600 shrink-0" />
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
                <div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={form.value.dueDate} onChange={(e) => form.setValue({ dueDate: e.target.value })} /></div>
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
                <div className="space-y-1.5"><Label>Notes</Label><Textarea rows={2} value={form.value.notes} onChange={(e) => form.setValue({ notes: e.target.value })} /></div>
                <div className="space-y-1.5"><Label>Terms</Label><Textarea rows={2} value={form.value.terms} onChange={(e) => form.setValue({ terms: e.target.value })} /></div>
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
            </>
          ) : (
            <div className="space-y-1.5">
              <Label>Due date</Label>
              <Input type="date" value={form.value.dueDate} onChange={(e) => form.setValue({ dueDate: e.target.value })} />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createInvoice} disabled={busy || refsLoading || (source === "wo" && woState !== "ready")}>
              {busy ? "Saving…" : "Create invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto print:hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Invoice {detail?.code ?? ""}
              {detail ? <StatusBadge status={detail.status} /> : null}
            </DialogTitle>
            <DialogDescription>Document preview, payments and workflow actions</DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <LoadingState label="Loading invoice…" rows={2} />
          ) : (
            <>
              <DocumentPreview inv={detail} company={company} />

              {detail.quotation || detail.workOrders.length > 0 ? (
                <div className="text-xs text-muted-foreground">
                  {detail.quotation ? <div>From quotation <span className="font-medium text-foreground">{detail.quotation.code}</span></div> : null}
                  {detail.workOrders.map((w) => <div key={w.id}>From work order <span className="font-medium text-foreground">{w.code}</span> — {w.title}</div>)}
                </div>
              ) : null}

              <div>
                <div className="text-sm font-medium mb-2">Payments ({detail.payments.length})</div>
                {detail.payments.length === 0 ? (
                  <p className="text-xs text-muted-foreground pb-2">No payments recorded yet.</p>
                ) : (
                  <div className="rounded-lg border overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b bg-muted/50 text-left">
                          <th className="px-2 py-2 font-medium">Code</th>
                          <th className="px-2 py-2 font-medium">Date</th>
                          <th className="px-2 py-2 font-medium">Method</th>
                          <th className="px-2 py-2 font-medium hidden sm:table-cell">Reference</th>
                          <th className="px-2 py-2 font-medium text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.payments.map((p) => (
                          <tr key={p.id} className="border-b last:border-0">
                            <td className="px-2 py-2 font-medium">{p.code}</td>
                            <td className="px-2 py-2">{fmtDate(p.paidAt)}</td>
                            <td className="px-2 py-2">{p.method.replaceAll("_", " ")}</td>
                            <td className="px-2 py-2 hidden sm:table-cell">{p.reference || "—"}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{money(p.amountCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2 pt-2 no-print">
                {canManage && detail.status === "DRAFT" ? (
                  <Button size="sm" disabled={busy} onClick={() => transition(detail.id, "send")}>
                    <Send className="h-4 w-4 mr-1.5" /> Send to customer
                  </Button>
                ) : null}
                {canRecord && !["DRAFT", "CANCELLED", "PAID"].includes(detail.status) && detail.balanceCents > 0 ? (
                  <Button size="sm" disabled={busy} onClick={openPayDialog}>
                    <CircleDollarSign className="h-4 w-4 mr-1.5" /> Record Payment
                  </Button>
                ) : null}
                {canManage && ["DRAFT", "SENT", "OVERDUE"].includes(detail.status) ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => transition(detail.id, "cancel")}>
                    <Ban className="h-4 w-4 mr-1.5" /> Cancel
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

      {/* Record payment dialog */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="max-w-md print:hidden">
          <DialogHeader>
            <DialogTitle>Record Payment — {detail?.code}</DialogTitle>
            <DialogDescription>
              Outstanding balance: {detail ? money(detail.balanceCents) : "—"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Amount (RM) *</Label>
                <Input inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Method *</Label>
                <Select value={payMethod} onValueChange={setPayMethod}>
                  <SelectTrigger aria-label="Method"><SelectValue /></SelectTrigger>
                  <SelectContent>{METHODS.map((m) => <SelectItem key={m} value={m}>{m.replaceAll("_", " ")}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Reference</Label>
              <Input value={payReference} onChange={(e) => setPayReference(e.target.value)} placeholder="e.g. MBB-889201" />
            </div>
            <div className="space-y-1.5">
              <Label>Note</Label>
              <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="Optional note" />
            </div>
            {payPreview ? (
              <div className="rounded-lg bg-muted/50 border p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">Payment amount</span><span className="tabular-nums">{money(Math.round((parseFloat(payAmount) || 0) * 100))}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">New balance</span><span className="tabular-nums font-medium">{money(payPreview.newBalanceCents)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Status after payment</span><StatusBadge status={payPreview.newStatus} /></div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)}>Cancel</Button>
            <Button onClick={recordPayment} disabled={busy}>{busy ? "Recording…" : "Record payment"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
