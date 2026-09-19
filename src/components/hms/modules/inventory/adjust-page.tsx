"use client";

// MOHD.HMS ENTERPRISE — Stock Adjustment (dedicated full page, inventory/{id}/adjust).
// Replaces the former "Adjust stock" dialog: movement type (RECEIVE/ISSUE/RETURN/
// ADJUST), quantity (signed delta when ADJUST), note — POST /api/v1/inventory/{id}/movement.
// A balance card shows the item's current stock before recording.
//
// Prefill source: the item is resolved from GET /api/v1/inventory (pageSize 200,
// same list the table shows) by id — no single-item GET contract is used by this
// module (documented integration point, same as the edit page).

import { useCallback, useEffect, useState } from "react";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, LoadingState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, humanize, type Permission } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeftRight, Loader2, PackagePlus } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

const MOVEMENT_TYPES = ["RECEIVE", "ISSUE", "RETURN", "ADJUST"] as const;
type MovementType = (typeof MOVEMENT_TYPES)[number];

type ItemRow = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  stockQty: number;
  minStockQty: number;
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

export function ItemAdjustPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.inventory_manage satisfies Permission);

  const [item, setItem] = useState<ItemRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [type, setType] = useState<MovementType>("RECEIVE");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Central unsaved-changes guard wiring (any touched field counts as unsaved).
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setDirty(false);
    try {
      const res = await api.get<ItemRow[]>(`/api/v1/inventory${qs({ pageSize: 200 })}`);
      const found = (Array.isArray(res.data) ? res.data : []).find((it) => it.id === id) ?? null;
      setItem(found);
    } catch (e) {
      setLoadError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (canManage) load(); }, [canManage, load]);

  const submitAdjust = useCallback(async () => {
    if (!item) return;
    const quantity = num(qty, NaN);
    if (!isFinite(quantity) || quantity === 0 || (type !== "ADJUST" && quantity <= 0)) {
      toast({
        title: "Invalid quantity",
        description: type === "ADJUST" ? "Enter a non-zero signed delta (e.g. -2 or 5)." : "Enter a positive quantity.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ item: ItemRow }>(`/api/v1/inventory/${item.id}/movement`, {
        type,
        quantity,
        note: note.trim() || undefined,
      });
      toast({
        title: "Stock updated",
        description: `${item.sku} — new balance ${res.data.item.stockQty} ${item.unit}.`,
      });
      setDirty(false);
      setPageDirty(false);
      navigateTo("inventory");
    } catch (e) {
      toast({ title: "Could not record movement", description: errMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [item, note, qty, setPageDirty, toast, type]);

  if (!canManage) {
    return (
      <EmptyState
        title="You don't have permission to manage inventory"
        hint="Recording stock movements is limited to authorized roles. Contact your administrator if you believe this is a mistake."
      />
    );
  }

  if (loading) {
    return (
      <PageShell
        backLabel="Back to Inventory"
        backHref="/inventory"
        crumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Stock Adjustment" }]}
        title="Adjust stock"
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
        crumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Stock Adjustment" }]}
        title="Adjust stock"
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
        crumbs={[{ label: "Inventory", href: "/inventory" }, { label: "Stock Adjustment" }]}
        title="Adjust stock"
      >
        <EmptyState title="Item not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Inventory"
      backHref="/inventory"
      crumbs={[{ label: "Inventory", href: "/inventory" }, { label: item.sku }, { label: "Stock Adjustment" }]}
      title={`Adjust stock — ${item.sku}`}
      description="Every movement is recorded in the ledger with the resulting balance."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => navigateTo("inventory")} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submitAdjust} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <PackagePlus className="h-4 w-4 mr-1.5" />}
            {saving ? "Recording…" : "Record movement"}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3 max-w-5xl">
        {/* Current balance card */}
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-3 lg:col-span-1 h-fit">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Current balance</p>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums">{item.stockQty}</span>
            <span className="text-sm text-muted-foreground">{item.unit}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={item.status} />
          </div>
          <dl className="text-sm space-y-1 text-muted-foreground border-t pt-3">
            <div className="flex justify-between gap-2">
              <dt>Item</dt>
              <dd className="font-medium text-foreground truncate max-w-[180px]">{item.name}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Minimum stock</dt>
              <dd className="tabular-nums font-medium text-foreground">{item.minStockQty} {item.unit}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>After movement</dt>
              <dd className={cn("tabular-nums font-medium", item.stockQty <= item.minStockQty ? "text-amber-600" : "text-emerald-600")}>
                {(() => {
                  const q = num(qty, 0);
                  const delta = type === "ISSUE" ? -Math.abs(q) : type === "ADJUST" ? q : Math.abs(q);
                  return `${item.stockQty + (isFinite(delta) ? delta : 0)} ${item.unit}`;
                })()}
              </dd>
            </div>
          </dl>
        </div>

        {/* Movement form */}
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-6 space-y-4 lg:col-span-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Movement type" className="sm:col-span-2">
              <Select
                value={type}
                onValueChange={(v) => {
                  setType(v as MovementType);
                  setDirty(true);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MOVEMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {humanize(t)}
                      {t === "RECEIVE" ? " (+)" : t === "ISSUE" ? " (−)" : t === "RETURN" ? " (+)" : " (±)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={type === "ADJUST" ? "Signed delta (e.g. -2 or 5)" : "Quantity"}>
              <Input
                type="number"
                step="any"
                value={qty}
                onChange={(e) => {
                  setQty(e.target.value);
                  setDirty(true);
                }}
                placeholder={type === "ADJUST" ? "-2" : "1"}
              />
            </Field>
            <Field label="Note" className="sm:col-span-2">
              <Textarea
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setDirty(true);
                }}
                placeholder="Reason / reference (optional)"
                rows={3}
              />
            </Field>
          </div>
          {dirty ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <ArrowLeftRight className="h-3 w-3" /> Unsaved changes — leaving this page will prompt for confirmation.
            </p>
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}
