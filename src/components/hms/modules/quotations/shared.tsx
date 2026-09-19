"use client";

// MOHD.HMS ENTERPRISE — Quotations module shared bits (moved from the former
// monolithic index.tsx): API mirror types, form factories, company-name loader
// and the printable DocumentPreview. Consumed by the list/new/detail pages.

import { customerLabel, fmtDate, money } from "@/lib/hms/format";
import { Separator } from "@/components/ui/separator";
import { humanize } from "@/lib/hms/constants";
import { DocumentHeader, FALLBACK_IDENTITY, loadCompanyIdentity, type CompanyIdentity } from "@/components/hms/shared/document-header";

// ── Types (mirror API responses) ──

export type CustomerLite = { id: string; code: string; companyName: string; contactPerson?: string; email?: string; phone?: string };

export type QuotationRow = {
  id: string; code: string; status: string;
  quotationDate: string; validUntil: string | null;
  subtotalCents: number; discountCents: number; taxCents: number; shippingCents: number; totalCents: number;
  customer: CustomerLite;
};

export type QuotationItemRow = {
  id: string; kind: string; description: string; quantity: number; unit: string;
  unitPriceCents: number; discountPercent: number; taxPercent: number; totalCents: number;
};

export type QuotationDetail = QuotationRow & {
  notes: string; terms: string; labourCostCents: number; materialCostCents: number;
  convertedInvoiceId: string | null;
  items: QuotationItemRow[];
};

export type InventoryLite = { id: string; sku: string; name: string; unit: string; unitCostCents: number };

export type FormItem = {
  kind: string; itemId: string; description: string; quantity: string; unit: string;
  unitPrice: string; discountPercent: string; taxPercent: string;
};

export type QForm = {
  customerId: string; validUntil: string; discount: string; shipping: string;
  notes: string; terms: string; items: FormItem[];
};

export const FALLBACK_COMPANY = FALLBACK_IDENTITY.name;

export const emptyItem = (): FormItem => ({ kind: "MATERIAL", itemId: "", description: "", quantity: "1", unit: "pcs", unitPrice: "", discountPercent: "0", taxPercent: "0" });
export const emptyForm = (): QForm => ({ customerId: "", validUntil: "", discount: "0", shipping: "0", notes: "", terms: "", items: [emptyItem()] });

/** Canonical company identity (settings-backed, graceful fallback). */
export { loadCompanyIdentity };
export type { CompanyIdentity };

// ── Document preview (screen card + print-only container) ──

export function DocumentPreview({ q, company }: { q: QuotationDetail; company: CompanyIdentity }) {
  return (
    <div className="text-sm">
      <DocumentHeader
        company={company}
        title="QUOTATION"
        number={q.code}
        meta={[
          { label: "Currency", value: "BND" },
          { label: "Dated", value: fmtDate(q.quotationDate) },
          { label: "Status", value: humanize(q.status) },
          { label: "Valid Until", value: q.validUntil ? fmtDate(q.validUntil) : "—" },
        ]}
      />
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Bill to</div>
        <div className="font-medium">{customerLabel(q.customer)}</div>
        {q.customer?.companyName && q.customer?.contactPerson ? <div className="text-xs text-muted-foreground">{q.customer.contactPerson}</div> : null}
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
