"use client";

// MOHD.HMS ENTERPRISE — Edit Inventory Item (dedicated full page, inventory/{id}/edit).
// Replaces the former "Edit item" dialog. Same PATCH /api/v1/inventory/{id} payload
// and validation. Stock quantity is deliberately NOT editable here — it changes
// only via stock movements (use the Stock Adjustment page).
//
// Prefill source: there is no single-item GET contract used by this module, so the
// item is resolved from GET /api/v1/inventory (pageSize 200, same list the table
// shows) by id. Documented integration point: a dedicated GET /inventory/{id}
// could replace this when available.

import { useCallback, useEffect, useState } from "react";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, LoadingState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { fromCents } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Pencil, Save } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type SupplierOpt = { id: string; name: string; status: string };

type ItemRow = {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  stockQty: number;
  minStockQty: number;
  unitCostCents: number;
  supplierId: string | null;
  status: string;
};

type EditForm = {
  name: string;
  category: string;
  unit: string;
  minStockQty: string;
  unitCost: string;
  supplierId: string; // "NONE" = no supplier
  status: string;
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

export function ItemEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.inventory_manage satisfies Permission);

  const [item, setItem] = useState<ItemRow | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<EditForm>({ name: "", category: "", unit: "", minStockQty: "", unitCost: "", supplierId: "NONE", status: "ACTIVE" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Central unsaved-changes guard wiring.
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setDirty(false);
    try {
      // Prefill from the inventory list (documented above) + supplier picker options.
      const [itemsRes, supRes] = await Promise.all([
        api.get<ItemRow[]>(`/api/v1/inventory${qs({ pageSize: 200 })}`),
        api.get<SupplierOpt[]>(`/api/v1/suppliers${qs({ pageSize: 200 })}`).catch(() => ({ data: [] as SupplierOpt[] })),
      ]);
      const found = (Array.isArray(itemsRes.data) ? itemsRes.data : []).find((it) => it.id === id) ?? null;
      setSuppliers(supRes.data);
      if (found) {
        setItem(found);
        setForm({
          name: found.name,
          category: found.category,
          unit: found.unit,
          minStockQty: String(found.minStockQty),
          unitCost: fromCents(found.unitCostCents),
          supplierId: found.supplierId ?? "NONE",
          status: found.status,
        });
      }
    } catch (e) {
      setLoadError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (canManage) load(); }, [canManage, load]);

  function patch(p: Partial<EditForm>) {
    setForm((prev) => ({ ...prev, ...p }));
    setDirty(true);
  }

  async function submitEdit() {
    if (!item) return;
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/api/v1/inventory/${item.id}`, {
        name: form.name.trim(),
        category: form.category.trim(),
        unit: form.unit.trim(),
        minStockQty: num(form.minStockQty),
        unitCost: num(form.unitCost),
        supplierId: form.supplierId === "NONE" ? null : form.supplierId,
        status: form.status,
      });
      toast({ title: "Item updated", description: item.sku });
      setDirty(false);
      setPageDirty(false);
      navigateTo("inventory");
    } catch (e) {
      toast({ title: "Could not update item", description: errMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <EmptyState
        title="You don't have permission to manage inventory"
        hint="Editing inventory items is limited to authorized roles. Contact your administrator if you believe this is a mistake."
      />
    );
  }

  const heading = item ? item.sku || item.name : "Edit item";

  if (loading) {
    return (
      <PageShell
        backLabel="Back to Inventory"
        backHref="/inventory"
        crumbs={[{ label: "Inventory", href: "/inventory" }, { label: heading }, { label: "Edit" }]}
        title="Edit item"
      >
        <LoadingState label="Loading item…" rows={4} />
      </PageShell>
    );
  }

  if (loadError) {
    return (
      <PageShell
        backLabel="Back to Inventory"
        backHref="/inventory"
        crumbs={[{ label: "Inventory", href: "/inventory" }, { label: heading }, { label: "Edit" }]}
        title="Edit item"
      >
        <EmptyState title="Could not load this item" hint={loadError} />
      </PageShell>
    );
  }

  if (!item) {
    return (
      <PageShell
        backLabel="Back to Inventory"
        backHref="/inventory"
        crumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Edit" }]}
        title="Edit item"
      >
        <EmptyState title="Item not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Inventory"
      backHref="/inventory"
      crumbs={[{ label: "Inventory", href: "/inventory" }, { label: item.sku || item.name }, { label: "Edit" }]}
      title={`Edit item ${item.sku}`}
      description="Stock quantity is changed via stock movements, not here — use Stock Adjustment on the list row."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => navigateTo("inventory")} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submitEdit} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      }
    >
      <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-6 space-y-4 max-w-3xl">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-mono text-xs text-muted-foreground">{item.sku}</span>
          <StatusBadge status={item.status} />
          <span className="text-muted-foreground">
            Current stock: <span className="tabular-nums font-medium text-foreground">{item.stockQty} {item.unit}</span>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Item name *" className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} />
          </Field>
          <Field label="Category">
            <Input value={form.category} onChange={(e) => patch({ category: e.target.value })} />
          </Field>
          <Field label="Unit">
            <Input value={form.unit} onChange={(e) => patch({ unit: e.target.value })} />
          </Field>
          <Field label="Minimum stock qty">
            <Input type="number" min="0" step="any" value={form.minStockQty} onChange={(e) => patch({ minStockQty: e.target.value })} />
          </Field>
          <Field label="Unit cost (BND)">
            <Input type="number" min="0" step="0.01" value={form.unitCost} onChange={(e) => patch({ unitCost: e.target.value })} />
          </Field>
          <Field label="Supplier">
            <Select value={form.supplierId} onValueChange={(v) => patch({ supplierId: v })}>
              <SelectTrigger>
                <SelectValue placeholder="Select supplier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">No supplier</SelectItem>
                {suppliers.filter((s) => s.status === "ACTIVE").map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={form.status} onValueChange={(v) => patch({ status: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="INACTIVE">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        {dirty ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Pencil className="h-3 w-3" /> Unsaved changes — leaving this page will prompt for confirmation.
          </p>
        ) : null}
      </div>
    </PageShell>
  );
}
