"use client";

// MOHD.HMS ENTERPRISE — Invoices module shared bits (moved from the former
// monolithic index.tsx): API mirror types, form factories, payment methods,
// company-name loader and the printable DocumentPreview (incl. Paid /
// Balance-due rows). Consumed by the list/new/detail/payment pages.

import { api } from "@/lib/hms/api-client";
import { fmtDate, money } from "@/lib/hms/format";
import { Separator } from "@/components/ui/separator";

// ── Types (mirror API responses) ──

export type CustomerLite = { id: string; code: string; companyName: string; contactPerson?: string; email?: string; phone?: string };

export type PaymentRow = {
  id: string; code: string; amountCents: number; method: string; reference: string;
  paidAt: string; note: string;
};

export type InvoiceRow = {
  id: string; code: string; status: string;
  invoiceDate: string; dueDate: string | null;
  subtotalCents: number; discountCents: number; taxCents: number; shippingCents: number;
  totalCents: number; paidCents: number; balanceCents: number;
  customer: CustomerLite;
};

export type InvoiceItemRow = {
  id: string; kind: string; description: string; quantity: number; unit: string;
  unitPriceCents: number; discountPercent: number; taxPercent: number; totalCents: number;
};

export type InvoiceDetail = InvoiceRow & {
  notes: string; terms: string; sentAt: string | null;
  items: InvoiceItemRow[];
  payments: PaymentRow[];
  quotation: { id: string; code: string } | null;
  workOrders: { id: string; code: string; title: string }[];
};

export type InventoryLite = { id: string; sku: string; name: string; unit: string; unitCostCents: number };
export type WoLite = { id: string; code: string; title: string; customer?: { companyName: string } | null };

export type FormItem = {
  kind: string; itemId: string; description: string; quantity: string; unit: string;
  unitPrice: string; discountPercent: string; taxPercent: string;
};

export type IForm = {
  customerId: string; dueDate: string; discount: string; shipping: string;
  notes: string; terms: string; items: FormItem[];
};

export const METHODS = ["CASH", "BANK_TRANSFER", "CARD", "CHEQUE", "ONLINE"] as const;
export const FALLBACK_COMPANY = "MOHD.HMS Enterprise";

export const emptyItem = (): FormItem => ({ kind: "MATERIAL", itemId: "", description: "", quantity: "1", unit: "pcs", unitPrice: "", discountPercent: "0", taxPercent: "0" });
export const emptyForm = (): IForm => ({ customerId: "", dueDate: "", discount: "0", shipping: "0", notes: "", terms: "", items: [emptyItem()] });

/** Resolve the company label from /api/v1/settings with a graceful fallback. */
export async function loadCompanyName(): Promise<string> {
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

// ── Invoice document preview (screen card + print-only container) ──

export function DocumentPreview({ inv, company }: { inv: InvoiceDetail; company: string }) {
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
