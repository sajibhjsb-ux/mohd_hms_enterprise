"use client";

// MOHD.HMS ENTERPRISE — Add Inventory Item (dedicated full page, inventory/new view).
// Replaces the former "Add inventory item" dialog. Same draft protection (formKey
// "inventory.item.create" kept so old drafts still restore), same payload to
// POST /api/v1/inventory, same fields — no popup, no new APIs.

import { useCallback, useEffect, useState } from "react";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { toCents } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, PackagePlus, Save } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type SupplierOpt = { id: string; name: string; status: string };

type ItemDraft = {
  sku: string;
  name: string;
  category: string;
  unit: string;
  stockQty: string;
  minStockQty: string;
  unitCost: string;
  supplierId: string;
};

const BLANK_ITEM_DRAFT: ItemDraft = {
  sku: "",
  name: "",
  category: "",
  unit: "pcs",
  stockQty: "",
  minStockQty: "",
  unitCost: "",
  supplierId: "",
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
      <span className="font-medium">Unsaved draft found.</span>
      <Button type="button" size="sm" variant="outline" className="h-7" onClick={onRestore}>
        Restore
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-7 text-amber-800" onClick={onDiscard}>
        Discard
      </Button>
    </div>
  );
}

export function ItemNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.inventory_manage satisfies Permission);

  const [saving, setSaving] = useState(false);
  const [suppliers, setSuppliers] = useState<SupplierOpt[] | null>(null);

  // Draft protection kept verbatim from the former dialog (same formKey).
  const draft = useDraft<ItemDraft>({ formKey: "inventory.item.create", initial: BLANK_ITEM_DRAFT });

  // Central unsaved-changes guard wiring.
  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  // Active suppliers for the picker (same data the dialog consumed).
  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    api.get<SupplierOpt[]>(`/api/v1/suppliers${qs({ pageSize: 200 })}`)
      .then((res) => { if (alive) setSuppliers(res.data); })
      .catch(() => { if (alive) setSuppliers([]); });
    return () => { alive = false; };
  }, [canManage]);

  const submitItem = useCallback(async () => {
    const v = draft.value;
    if (!v.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/v1/inventory", {
        sku: v.sku.trim() || undefined,
        name: v.name.trim(),
        category: v.category.trim() || undefined,
        unit: v.unit.trim() || undefined,
        stockQty: num(v.stockQty),
        minStockQty: num(v.minStockQty),
        unitCost: toCents(v.unitCost || "0") / 100,
        supplierId: v.supplierId || undefined,
      });
      toast({ title: "Item created", description: `${v.name.trim()} added to inventory.` });
      draft.reset(BLANK_ITEM_DRAFT);
      setPageDirty(false);
      // Back to the list (Items tab is the default view).
      navigateTo("inventory");
    } catch (e) {
      toast({ title: "Could not create item", description: errMessage(e), variant: "destructive" });
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
        title="You don't have permission to manage inventory"
        hint="Adding inventory items is limited to authorized roles. Contact your administrator if you believe this is a mistake."
      />
    );
  }

  return (
    <PageShell
      backLabel="Back to Inventory"
      backHref="#/inventory"
      crumbs={[{ label: "Inventory", href: "#/inventory" }, { label: "Add Item" }]}
      title="Add inventory item"
      description="SKU is generated automatically (ITM-…) when left blank. Opening stock creates the first movement."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={saveDraft} disabled={saving}>
            <Save className="h-4 w-4 mr-1.5" /> Save Draft
          </Button>
          <Button onClick={submitItem} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <PackagePlus className="h-4 w-4 mr-1.5" />}
            {saving ? "Creating…" : "Create item"}
          </Button>
        </div>
      }
    >
      <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-6 space-y-4 max-w-3xl">
        <DraftBanner draftExists={draft.draftExists} onRestore={draft.restore} onDiscard={draft.discard} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="SKU">
            <Input value={draft.value.sku} onChange={(e) => draft.setValue({ sku: e.target.value })} placeholder="Auto (ITM-…)" />
          </Field>
          <Field label="Item name *">
            <Input value={draft.value.name} onChange={(e) => draft.setValue({ name: e.target.value })} placeholder="e.g. Air filter 20x20" />
          </Field>
          <Field label="Category">
            <Input value={draft.value.category} onChange={(e) => draft.setValue({ category: e.target.value })} placeholder="e.g. FILTERS" />
          </Field>
          <Field label="Unit">
            <Input value={draft.value.unit} onChange={(e) => draft.setValue({ unit: e.target.value })} placeholder="pcs" />
          </Field>
          <Field label="Opening stock qty">
            <Input type="number" min="0" step="any" value={draft.value.stockQty} onChange={(e) => draft.setValue({ stockQty: e.target.value })} placeholder="0" />
          </Field>
          <Field label="Minimum stock qty">
            <Input type="number" min="0" step="any" value={draft.value.minStockQty} onChange={(e) => draft.setValue({ minStockQty: e.target.value })} placeholder="0" />
          </Field>
          <Field label="Unit cost (RM)">
            <Input type="number" min="0" step="0.01" value={draft.value.unitCost} onChange={(e) => draft.setValue({ unitCost: e.target.value })} placeholder="0.00" />
          </Field>
          <Field label="Supplier">
            <Select value={draft.value.supplierId || "NONE"} onValueChange={(v) => draft.setValue({ supplierId: v === "NONE" ? "" : v })}>
              <SelectTrigger>
                <SelectValue placeholder="Select supplier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">No supplier</SelectItem>
                {(suppliers ?? []).filter((s) => s.status === "ACTIVE").map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {draft.dirty ? (
          <p className="text-xs text-muted-foreground">Draft auto-saves locally while you type.</p>
        ) : null}
      </div>
    </PageShell>
  );
}
