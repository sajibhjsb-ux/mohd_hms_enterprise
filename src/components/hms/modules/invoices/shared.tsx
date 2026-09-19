"use client";

// MOHD.HMS ENTERPRISE — Invoices module shared bits (moved from the former
// monolithic index.tsx): API mirror types, form factories, payment methods,
// company-name loader and the printable DocumentPreview (incl. Paid /
// Balance-due rows). Consumed by the list/new/detail/payment pages.

import { customerLabel, fmtDate, money } from "@/lib/hms/format";
import { Separator } from "@/components/ui/separator";
import { humanize } from "@/lib/hms/constants";
import { DocumentHeader, FALLBACK_IDENTITY, loadCompanyIdentity, type CompanyIdentity } from "@/components/hms/shared/document-header";

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
export type WoLite = { id: string; code: string; title: string; customer?: { companyName?: string; contactPerson?: string } | null };

export type FormItem = {
  kind: string; itemId: string; description: string; quantity: string; unit: string;
  unitPrice: string; discountPercent: string; taxPercent: string;
};

export type IForm = {
  customerId: string; dueDate: string; discount: string; shipping: string;
  notes: string; terms: string; items: FormItem[];
};

export const METHODS = ["CASH", "BANK_TRANSFER", "CARD", "CHEQUE", "ONLINE"] as const;
export const FALLBACK_COMPANY = FALLBACK_IDENTITY.name;

export const emptyItem = (): FormItem => ({ kind: "MATERIAL", itemId: "", description: "", quantity: "1", unit: "pcs", unitPrice: "", discountPercent: "0", taxPercent: "0" });
export const emptyForm = (): IForm => ({ customerId: "", dueDate: "", discount: "0", shipping: "0", notes: "", terms: "", items: [emptyItem()] });

/** Canonical company identity (settings-backed, graceful fallback). */
export { loadCompanyIdentity };
export type { CompanyIdentity };

// ── Invoice document preview (screen card + print-only container) ──

export function DocumentPreview({ inv, company }: { inv: InvoiceDetail; company: CompanyIdentity }) {
  return (
    <div className="text-sm">
      <DocumentHeader
        company={company}
        title="INVOICE"
        number={inv.code}
        meta={[
          { label: "Currency", value: "BND" },
          { label: "Issued", value: fmtDate(inv.invoiceDate) },
          { label: "Status", value: humanize(inv.status) },
          { label: "Due", value: inv.dueDate ? fmtDate(inv.dueDate) : "—" },
        ]}
      />
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Bill to</div>
        <div className="font-medium">{customerLabel(inv.customer)}</div>
        {inv.customer?.companyName && inv.customer?.contactPerson ? <div className="text-xs text-muted-foreground">{inv.customer.contactPerson}</div> : null}
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
