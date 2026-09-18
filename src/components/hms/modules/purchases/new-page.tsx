"use client";

// MOHD.HMS ENTERPRISE — New Purchase Order (dedicated full page, purchases/new view).
// Replaces the former "New purchase order" dialog. Same draft protection (formKey
// "purchase.create" kept so old PO drafts still restore), same line editor, same
// client totals math (integer cents, 6% tax), same POST /api/v1/purchases payload
// — no popup, no new APIs.
// Refs: GET /api/v1/suppliers + GET /api/v1/inventory?status=ACTIVE (on mount).

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { fromCents, money } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Loader2, Plus, Save, ShoppingCart, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type SupplierOption = { id: string; code: string; name: string; status: string };

type ItemOption = { id: string; sku: string; name: string; unitCostCents: number; unit: string; status: string };

type PoLineDraft = { itemId: string; description: string; quantity: string; unitCost: string };
type PoDraft = { supplierId: string; expectedDate: string; notes: string; items: PoLineDraft[] };

const BLANK_PO_DRAFT: PoDraft = {
  supplierId: "",
  expectedDate: "",
  notes: "",
  items: [{ itemId: "", description: "", quantity: "1", unitCost: "" }],
};

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

function num(value: string, fallback = 0): number {
  const n = parseFloat(value);
  return isFinite(n) ? n : fallback;
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function DraftBanner({
  draftExists,
  onRestore,
  onDiscard,
}: {
  draftExists: boolean;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  if (!draftExists) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <span className="font-medium">Unsaved PO draft found.</span>
      <Button type="button" size="sm" variant="outline" className="h-7" onClick={onRestore}>
        Restore
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-7 text-amber-800" onClick={onDiscard}>
        Discard
      </Button>
    </div>
  );
}

/** Mirror of the server totals math (integer cents, 6% tax). */
function computeTotals(lines: PoLineDraft[]) {
  let subtotalCents = 0;
  for (const l of lines) {
    const unitCostCents = Math.round(num(l.unitCost) * 100);
    subtotalCents += Math.round(num(l.quantity) * unitCostCents);
  }
  const taxCents = Math.round(subtotalCents * 0.06);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function PurchaseNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  // The former dialog gated "New purchase order" with purchases_manage (the
  // permission matrix has no purchases.create — purchases_manage is the create gate).
  const canManage = hasPerm(user, PERMISSIONS.purchases_manage satisfies Permission);

  const [saving, setSaving] = useState(false);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [itemOptions, setItemOptions] = useState<ItemOption[]>([]);

  // Draft protection kept verbatim from the former dialog (same formKey).
  const draft = useDraft<PoDraft>({ formKey: "purchase.create", initial: BLANK_PO_DRAFT });

  // Central unsaved-changes guard wiring.
  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  // Reference data (same fetches the dialog relied on, now page-scoped).
  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    api
      .get<SupplierOption[]>(`/api/v1/suppliers${qs({ pageSize: 200 })}`)
      .then((res) => { if (alive) setSuppliers(res.data.filter((s) => s.status === "ACTIVE")); })
      .catch(() => { if (alive) setSuppliers([]); });
    api
      .get<ItemOption[]>(`/api/v1/inventory${qs({ pageSize: 200, status: "ACTIVE" })}`)
      .then((res) => { if (alive) setItemOptions(res.data); })
      .catch(() => { if (alive) setItemOptions([]); });
    return () => { alive = false; };
  }, [canManage]);

  const totals = useMemo(() => computeTotals(draft.value.items), [draft.value.items]);

  function updateLine(idx: number, patch: Partial<PoLineDraft>) {
    const lines = draft.value.items.map((l, i) => (i === idx ? { ...l, ...patch } : l));
    draft.setValue({ items: lines });
  }

  function addLine() {
    draft.setValue({ items: [...draft.value.items, { itemId: "", description: "", quantity: "1", unitCost: "" }] });
  }

  function removeLine(idx: number) {
    if (draft.value.items.length <= 1) return;
    draft.setValue({ items: draft.value.items.filter((_, i) => i !== idx) });
  }

  function pickItem(idx: number, value: string) {
    if (value === "CUSTOM") {
      updateLine(idx, { itemId: "", description: "" });
      return;
    }
    const item = itemOptions.find((o) => o.id === value);
    if (!item) return;
    updateLine(idx, { itemId: item.id, description: item.name, unitCost: fromCents(item.unitCostCents) });
  }

  const submitPo = useCallback(async () => {
    const v = draft.value;
    if (!v.supplierId) {
      toast({ title: "Supplier is required", variant: "destructive" });
      return;
    }
    const lines = v.items.filter((l) => l.description.trim() || l.itemId);
    if (lines.length === 0) {
      toast({ title: "Add at least one item", variant: "destructive" });
      return;
    }
    for (const l of lines) {
      if (!l.description.trim()) {
        toast({ title: "Every line needs a description", variant: "destructive" });
        return;
      }
      if (num(l.quantity) <= 0) {
        toast({ title: "Quantities must be greater than zero", variant: "destructive" });
        return;
      }
      if (num(l.unitCost) < 0) {
        toast({ title: "Unit cost cannot be negative", variant: "destructive" });
        return;
      }
    }
    setSaving(true);
    try {
      const res = await api.post<{ id: string; code: string }>("/api/v1/purchases", {
        supplierId: v.supplierId,
        expectedDate: v.expectedDate || undefined,
        notes: v.notes.trim() || undefined,
        items: lines.map((l) => ({
          itemId: l.itemId || undefined,
          description: l.description.trim(),
          quantity: num(l.quantity),
          unitCost: num(l.unitCost),
        })),
      });
      toast({ title: "Purchase order created", description: `${res.data.code} saved as draft.` });
      draft.reset(BLANK_PO_DRAFT);
      setPageDirty(false);
      // Continue the workflow on the PO's dedicated detail page.
      navigateTo("purchases", [res.data.id]);
    } catch (e) {
      // Keep every user-entered value on failure — draft autosave has it covered.
      toast({ title: "Could not create purchase order", description: errMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [draft, setPageDirty, toast]);

  function saveDraft() {
    draft.saveNow();
    toast({ title: "Draft saved successfully", description: "You can safely leave this page and restore the draft later." });
  }

  if (!canManage) {
    return (
      <EmptyState
        title="You don't have permission to create purchase orders"
        hint="Raising purchase orders is limited to authorized roles. Contact your administrator if you believe this is a mistake."
      />
    );
  }

  return (
    <PageShell
      backLabel="Back to Purchases"
      backHref="#/purchases"
      crumbs={[{ label: "Purchases", href: "#/purchases" }, { label: "New Purchase Order" }]}
      title="New Purchase Order"
      description="Pick supplier, expected delivery and order lines — choose inventory items with prefilled rates or type free-text lines. Totals (6% tax) are computed for you, and your work drafts automatically."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={saveDraft} disabled={saving}>
            <Save className="h-4 w-4 mr-1.5" /> Save Draft
          </Button>
          <Button onClick={submitPo} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ShoppingCart className="h-4 w-4 mr-1.5" />}
            {saving ? "Creating…" : "Create PO (draft)"}
          </Button>
        </div>
      }
    >
      <div className="max-w-4xl space-y-4">
        <DraftBanner draftExists={draft.draftExists} onRestore={draft.restore} onDiscard={draft.discard} />

        {/* Supplier + expected date */}
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Supplier *" className="sm:col-span-2">
              <Select value={draft.value.supplierId || "NONE"} onValueChange={(v) => draft.setValue({ supplierId: v === "NONE" ? "" : v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select supplier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE" disabled>
                    Select supplier
                  </SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Expected date">
              <Input type="date" value={draft.value.expectedDate} onChange={(e) => draft.setValue({ expectedDate: e.target.value })} />
            </Field>
          </div>
        </div>

        {/* Lines editor */}
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-6 space-y-3">
          <Label className="text-xs font-medium text-muted-foreground">Items *</Label>
          <div className="space-y-2">
            {draft.value.items.map((line, idx) => (
              <div key={idx} className="rounded-xl border bg-muted/20 p-3 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                  <div className="sm:col-span-5">
                    <Select value={line.itemId || "CUSTOM"} onValueChange={(v) => pickItem(idx, v)}>
                      <SelectTrigger className="h-9" aria-label="Inventory item">
                        <SelectValue placeholder="Inventory item" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CUSTOM">Custom (free text)</SelectItem>
                        {itemOptions.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.sku} — {o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-3">
                    <Input
                      className="h-9"
                      placeholder={line.itemId ? "Description (from item)" : "Description"}
                      value={line.description}
                      onChange={(e) => updateLine(idx, { description: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Input
                      className="h-9"
                      type="number"
                      min="0"
                      step="any"
                      placeholder="Qty"
                      aria-label="Quantity"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Input
                      className="h-9"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Unit cost RM"
                      aria-label="Unit cost in RM"
                      value={line.unitCost}
                      onChange={(e) => updateLine(idx, { unitCost: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Line {idx + 1}</span>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums">Line total: {money(Math.round(num(line.quantity) * Math.round(num(line.unitCost) * 100)))}</span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-red-600"
                      disabled={draft.value.items.length <= 1}
                      aria-label={`Remove line ${idx + 1}`}
                      onClick={() => removeLine(idx)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add line
          </Button>
        </div>

        {/* Notes */}
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-6">
          <Field label="Notes">
            <Textarea value={draft.value.notes} onChange={(e) => draft.setValue({ notes: e.target.value })} rows={3} placeholder="Delivery instructions, quotation ref…" />
          </Field>
        </div>

        {/* Totals */}
        <div className="rounded-xl border bg-muted/20 p-4 sm:p-5 space-y-1.5 text-sm max-w-xs ml-auto">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="tabular-nums">{money(totals.subtotalCents)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tax (6%)</span>
            <span className="tabular-nums">{money(totals.taxCents)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-semibold">
            <span>Grand total</span>
            <span className="tabular-nums">{money(totals.totalCents)}</span>
          </div>
        </div>

        {draft.dirty ? (
          <p className="text-xs text-muted-foreground">Draft auto-saves locally while you type.</p>
        ) : null}
      </div>
    </PageShell>
  );
}
