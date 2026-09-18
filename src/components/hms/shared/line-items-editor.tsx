"use client";

// MOHD.HMS ENTERPRISE — shared line-items editor for quotation/invoice forms.
// Extracted verbatim from the former create dialogs (agent 6-e markup): kind
// Select (MATERIAL/LABOUR/SERVICE/CUSTOM), inventory pick-or-custom with
// autofill, description, qty/unit/price/discount/tax, remove + live line total,
// and the document totals panel. Purely presentational — pages own the state.

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { money } from "@/lib/hms/format";
import { Plus, Trash2 } from "lucide-react";

// ── Types (structurally identical to the form items of both modules) ──

export type LineItemValue = {
  kind: string; itemId: string; description: string; quantity: string; unit: string;
  unitPrice: string; discountPercent: string; taxPercent: string;
};

export type InventoryOpt = { id: string; sku: string; name: string; unit: string; unitCostCents: number };

export const LINE_KINDS = ["MATERIAL", "LABOUR", "SERVICE", "CUSTOM"] as const;

// ── Client-side math — mirrors the server exactly ──

export function lineTotalCents(quantity: string, unitPrice: string, discountPercent: string): number {
  const qty = parseFloat(quantity) || 0;
  const cents = Math.round((parseFloat(unitPrice) || 0) * 100);
  const disc = parseFloat(discountPercent) || 0;
  return Math.round(qty * cents * (1 - disc / 100));
}

export function formTotals(items: LineItemValue[], discount: string, shipping: string) {
  const subtotalCents = items.reduce((s, it) => s + lineTotalCents(it.quantity, it.unitPrice, it.discountPercent), 0);
  const taxCents = items.reduce((s, it) => s + Math.round((lineTotalCents(it.quantity, it.unitPrice, it.discountPercent) * (parseFloat(it.taxPercent) || 0)) / 100), 0);
  const discountCents = Math.round((parseFloat(discount) || 0) * 100);
  const shippingCents = Math.round((parseFloat(shipping) || 0) * 100);
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents + shippingCents);
  return { subtotalCents, taxCents, discountCents, shippingCents, totalCents };
}

// ── Editor ──

type Props = {
  items: LineItemValue[];
  inventory: InventoryOpt[];
  /** Patch one line (typed by the user). */
  onChange: (index: number, patch: Partial<LineItemValue>) => void;
  /** Inventory pick — value is an inventory id or "CUSTOM" (clears the pick). */
  onPickInventory: (index: number, itemId: string) => void;
  /** Remove one line. */
  onRemove: (index: number) => void;
  onAdd: () => void;
  /** Disable the "Add item" button while references are still loading. */
  addDisabled?: boolean;
};

export function LineItemsEditor({ items, inventory, onChange, onPickInventory, onRemove, onAdd, addDisabled }: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Line items *</Label>
        <Button type="button" size="sm" variant="outline" onClick={onAdd} disabled={addDisabled}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add item
        </Button>
      </div>
      {items.map((it, idx) => (
        <div key={idx} className="rounded-lg border p-3 space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Select value={it.kind} onValueChange={(v) => onChange(idx, { kind: v })}>
              <SelectTrigger aria-label="Kind"><SelectValue /></SelectTrigger>
              <SelectContent>{LINE_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={it.itemId || "CUSTOM"} onValueChange={(v) => onPickInventory(idx, v === "CUSTOM" ? "" : v)}>
              <SelectTrigger aria-label="Inventory item" className="sm:col-span-3">
                <SelectValue placeholder="Custom line — or pick from inventory" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CUSTOM">Custom line</SelectItem>
                {inventory.map((inv) => <SelectItem key={inv.id} value={inv.id}>{inv.name} · {inv.sku}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Input placeholder="Description" value={it.description} onChange={(e) => onChange(idx, { description: e.target.value })} aria-label="Description" />
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            <div className="space-y-1"><Label className="text-xs text-muted-foreground">Qty</Label><Input inputMode="decimal" value={it.quantity} onChange={(e) => onChange(idx, { quantity: e.target.value })} /></div>
            <div className="space-y-1"><Label className="text-xs text-muted-foreground">Unit</Label><Input value={it.unit} onChange={(e) => onChange(idx, { unit: e.target.value })} /></div>
            <div className="space-y-1"><Label className="text-xs text-muted-foreground">Price (BND)</Label><Input inputMode="decimal" value={it.unitPrice} onChange={(e) => onChange(idx, { unitPrice: e.target.value })} placeholder="0.00" /></div>
            <div className="space-y-1"><Label className="text-xs text-muted-foreground">Disc %</Label><Input inputMode="decimal" value={it.discountPercent} onChange={(e) => onChange(idx, { discountPercent: e.target.value })} /></div>
            <div className="space-y-1"><Label className="text-xs text-muted-foreground">Tax %</Label><Input inputMode="decimal" value={it.taxPercent} onChange={(e) => onChange(idx, { taxPercent: e.target.value })} /></div>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-red-600 hover:text-red-700 hover:bg-red-50"
              disabled={items.length === 1}
              onClick={() => onRemove(idx)}>
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
            </Button>
            <span>Line total: <strong className="text-foreground tabular-nums">{money(lineTotalCents(it.quantity, it.unitPrice, it.discountPercent))}</strong></span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Totals panel (same box the dialogs showed under the form) ──

export function TotalsPanel({ totals, extraRows }: { totals: { subtotalCents: number; discountCents: number; taxCents: number; shippingCents: number; totalCents: number }; extraRows?: ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/50 border p-3 text-sm space-y-1">
      <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{money(totals.subtotalCents)}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular-nums">-{money(totals.discountCents)}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{money(totals.taxCents)}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Shipping</span><span className="tabular-nums">{money(totals.shippingCents)}</span></div>
      {extraRows}
      <Separator />
      <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">{money(totals.totalCents)}</span></div>
    </div>
  );
}
