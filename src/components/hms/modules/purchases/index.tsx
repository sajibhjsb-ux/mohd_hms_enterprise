"use client";

// MOHD.HMS ENTERPRISE — Purchases module: purchase orders + approval workflow.
// Data comes exclusively from /api/v1/purchases, /api/v1/suppliers, /api/v1/inventory.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { hasPerm, useSession } from "@/components/hms/session";
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/hooks/use-toast";
import { fmtDate, fromCents, money } from "@/lib/hms/format";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Check, CheckCheck, Plus, ShoppingCart, Trash2, X, ClipboardCheck, Hourglass } from "lucide-react";

// ───────────────────────────── types ─────────────────────────────

type SupplierOption = { id: string; code: string; name: string; status: string };

type ItemOption = { id: string; sku: string; name: string; unitCostCents: number; unit: string; status: string };

type POItemRow = {
  id: string;
  itemId: string | null;
  item: { id: string; sku: string; name: string; unit: string } | null;
  description: string;
  quantity: number;
  unitCostCents: number;
  totalCents: number;
  receivedQty: number;
};

type PurchaseOrderListRow = {
  id: string;
  code: string;
  status: string;
  orderDate: string;
  expectedDate: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  supplier: { id: string; name: string } | null;
  _count?: { items: number };
};

type PurchaseOrderDetail = {
  id: string;
  code: string;
  status: string;
  orderDate: string;
  expectedDate: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  notes: string;
  approvedAt: string | null;
  receivedAt: string | null;
  supplier: { id: string; name: string; code?: string } | null;
  items: POItemRow[];
};

type PurchaseStats = { awaitingApproval: number; approvedOpen: number; receivedThisMonth: number };

// ───────────────────────────── helpers ─────────────────────────────

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

type PoLineDraft = { itemId: string; description: string; quantity: string; unitCost: string };
type PoDraft = { supplierId: string; expectedDate: string; notes: string; items: PoLineDraft[] };

const BLANK_PO_DRAFT: PoDraft = {
  supplierId: "",
  expectedDate: "",
  notes: "",
  items: [{ itemId: "", description: "", quantity: "1", unitCost: "" }],
};

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

// ───────────────────────────── module ─────────────────────────────

export function PurchasesModule() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.purchases_manage satisfies Permission);
  const canApprove = hasPerm(user, PERMISSIONS.purchases_approve satisfies Permission);

  // List + stats
  const [pos, setPos] = useState<PurchaseOrderListRow[] | null>(null);
  const [stats, setStats] = useState<PurchaseStats | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  // Reference data
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [itemOptions, setItemOptions] = useState<ItemOption[]>([]);

  // New PO dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const draft = useDraft<PoDraft>({ formKey: "purchase.create", initial: BLANK_PO_DRAFT });

  // Detail dialog
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});

  const loadPos = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await api.get<PurchaseOrderListRow[]>(`/api/v1/purchases${qs({ pageSize: 200 })}`);
      setPos(res.data);
      const s = (res.meta as { stats?: PurchaseStats } | undefined)?.stats;
      if (s) setStats(s);
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPos();
    api
      .get<SupplierOption[]>(`/api/v1/suppliers${qs({ pageSize: 200 })}`)
      .then((res) => setSuppliers(res.data.filter((s) => s.status === "ACTIVE")))
      .catch(() => setSuppliers([]));
    api
      .get<ItemOption[]>(`/api/v1/inventory${qs({ pageSize: 200, status: "ACTIVE" })}`)
      .then((res) => setItemOptions(res.data))
      .catch(() => setItemOptions([]));
  }, [loadPos]);

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id);
    setDetail(null);
    setDetailErr("");
    setReceiveOpen(false);
    setReceiveQty({});
    setDetailLoading(true);
    try {
      const res = await api.get<PurchaseOrderDetail>(`/api/v1/purchases/${id}`);
      setDetail(res.data);
    } catch (e) {
      setDetailErr(errMessage(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // ── create PO ──

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

  async function submitPo() {
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
      const res = await api.post<PurchaseOrderListRow>("/api/v1/purchases", {
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
      setCreateOpen(false);
      loadPos();
    } catch (e) {
      toast({ title: "Could not create purchase order", description: errMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── transitions ──

  async function transition(action: string, extra?: Record<string, unknown>, successMsg?: string) {
    if (!detail) return;
    setBusy(action);
    try {
      const res = await api.post<PurchaseOrderDetail>(`/api/v1/purchases/${detail.id}/transition`, { action, ...extra });
      setDetail(res.data);
      toast({ title: successMsg ?? "Purchase order updated", description: `${res.data.code} → ${res.data.status.replaceAll("_", " ").toLowerCase()}` });
      setReceiveOpen(false);
      setReceiveQty({});
      loadPos();
    } catch (e) {
      toast({ title: "Action failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  function openReceive() {
    if (!detail) return;
    const init: Record<string, string> = {};
    for (const it of detail.items) {
      const remaining = Math.max(0, it.quantity - it.receivedQty);
      init[it.id] = String(remaining > 0 ? remaining : 0);
    }
    setReceiveQty(init);
    setReceiveOpen(true);
  }

  function confirmReceive() {
    if (!detail) return;
    const lines = detail.items
      .map((it) => ({ purchaseItemId: it.id, quantity: num(receiveQty[it.id] ?? "0") }))
      .filter((l) => l.quantity > 0);
    if (lines.length === 0) {
      toast({ title: "Enter at least one receive quantity", variant: "destructive" });
      return;
    }
    for (const line of lines) {
      const it = detail.items.find((i) => i.id === line.purchaseItemId);
      if (it && line.quantity > it.quantity - it.receivedQty + 1e-9) {
        toast({ title: `Quantity for "${it.description}" exceeds remaining`, variant: "destructive" });
        return;
      }
    }
    transition("receive", { items: lines }, "Stock received");
  }

  // ── list columns ──

  const columns: Column<PurchaseOrderListRow>[] = [
    { key: "code", header: "PO", value: (r) => r.code, render: (r) => <span className="font-mono text-xs font-medium">{r.code}</span> },
    { key: "supplier", header: "Supplier", value: (r) => r.supplier?.name ?? "", render: (r) => r.supplier?.name ?? "—" },
    { key: "orderDate", header: "Order date", value: (r) => r.orderDate, render: (r) => fmtDate(r.orderDate), hideOnMobile: true },
    { key: "expectedDate", header: "Expected", value: (r) => r.expectedDate ?? "", render: (r) => fmtDate(r.expectedDate), hideOnMobile: true },
    { key: "items", header: "Items", value: (r) => r._count?.items ?? 0, className: "tabular-nums" },
    { key: "totalCents", header: "Total", value: (r) => r.totalCents / 100, render: (r) => <span className="tabular-nums font-medium">{money(r.totalCents)}</span> },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
  ];

  const status = detail?.status;
  const receiving = status === "APPROVED" || status === "PARTIALLY_RECEIVED";

  return (
    <div>
      <PageHeader
        title="Purchases"
        subtitle="Purchase orders, approvals and goods receipt"
        actions={
          canManage ? (
            <Button
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-1.5" /> New purchase order
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-5">
        <StatCard title="Awaiting approval" value={stats ? stats.awaitingApproval : "—"} sub="Pending with finance" icon={<Hourglass className="h-5 w-5" />} tone={stats && stats.awaitingApproval > 0 ? "warning" : "default"} loading={!stats} />
        <StatCard title="Approved / open" value={stats ? stats.approvedOpen : "—"} sub="Awaiting goods receipt" icon={<ShoppingCart className="h-5 w-5" />} loading={!stats} />
        <StatCard title="Received this month" value={stats ? stats.receivedThisMonth : "—"} sub="Completed orders" icon={<ClipboardCheck className="h-5 w-5" />} tone="success" loading={!stats} />
      </div>

      {loading && !pos ? (
        <LoadingState label="Loading purchase orders…" />
      ) : err ? (
        <ErrorState message={err} onRetry={loadPos} />
      ) : pos && pos.length === 0 ? (
        <EmptyState
          title="No purchase orders yet"
          hint={canManage ? "Raise your first PO to buy inventory from a supplier." : "Purchase orders will appear here once raised."}
          action={
            canManage ? (
              <Button
                onClick={() => {
                  setCreateOpen(true);
                }}
              >
                <Plus className="h-4 w-4 mr-1.5" /> New purchase order
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={pos ?? []}
          rowKey={(r) => r.id}
          onRowClick={(r) => openDetail(r.id)}
          searchPlaceholder="Search PO code or supplier…"
          emptyTitle="No purchase orders"
          exportName="purchase-orders"
          filters={[
            {
              key: "status",
              label: "Status",
              options: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"].map((s) => ({
                value: s,
                label: s.replaceAll("_", " "),
              })),
              match: (r, v) => r.status === v,
            },
          ]}
        />
      )}

      {/* New PO dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New purchase order</DialogTitle>
            <DialogDescription>Pick inventory items or type free-text lines. Totals are computed for you (6% tax).</DialogDescription>
          </DialogHeader>
          <DraftBanner draftExists={draft.draftExists} onRestore={draft.restore} onDiscard={draft.discard} />
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

          <div className="space-y-2">
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

          <Field label="Notes">
            <Textarea value={draft.value.notes} onChange={(e) => draft.setValue({ notes: e.target.value })} rows={2} placeholder="Delivery instructions, quotation ref…" />
          </Field>

          <div className="rounded-xl border bg-muted/20 p-3 space-y-1.5 text-sm">
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

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitPo} disabled={saving}>
              {saving ? "Creating…" : "Create PO (draft)"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PO detail dialog */}
      <Dialog open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
          <DialogTitle className="sr-only">Details</DialogTitle>
          {detailLoading ? (
            <LoadingState label="Loading purchase order…" />
          ) : detailErr ? (
            <ErrorState message={detailErr} onRetry={() => detailId && openDetail(detailId)} />
          ) : detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{detail.code}</span>
                  <StatusBadge status={detail.status} />
                </DialogTitle>
                <DialogDescription>
                  {detail.supplier?.name ?? "—"} · ordered {fmtDate(detail.orderDate)}
                  {detail.expectedDate ? ` · expected ${fmtDate(detail.expectedDate)}` : ""}
                  {detail.receivedAt ? ` · received ${fmtDate(detail.receivedAt)}` : ""}
                </DialogDescription>
              </DialogHeader>

              <div className="rounded-xl border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[180px]">Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">Unit cost</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      {receiveOpen && receiving ? <TableHead className="text-right w-[110px]">Receive qty</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.items.map((it) => {
                      const remaining = Math.max(0, it.quantity - it.receivedQty);
                      return (
                        <TableRow key={it.id}>
                          <TableCell>
                            <div className="font-medium">{it.description}</div>
                            {it.item ? <div className="font-mono text-xs text-muted-foreground">{it.item.sku}</div> : null}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{it.quantity}</TableCell>
                          <TableCell className="text-right tabular-nums hidden sm:table-cell">{money(it.unitCostCents)}</TableCell>
                          <TableCell className="text-right tabular-nums">{money(it.totalCents)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums", it.receivedQty >= it.quantity ? "text-emerald-600" : "text-amber-600")}>
                            {it.receivedQty}/{it.quantity}
                          </TableCell>
                          {receiveOpen && receiving ? (
                            <TableCell className="text-right">
                              <Input
                                className="h-8 w-20 ml-auto text-right"
                                type="number"
                                min="0"
                                step="any"
                                disabled={remaining <= 0}
                                aria-label={`Receive quantity for ${it.description}`}
                                value={receiveQty[it.id] ?? ""}
                                onChange={(e) => setReceiveQty((p) => ({ ...p, [it.id]: e.target.value }))}
                              />
                            </TableCell>
                          ) : null}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="ml-auto max-w-xs space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">{money(detail.subtotalCents)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tax (6%)</span>
                  <span className="tabular-nums">{money(detail.taxCents)}</span>
                </div>
                <Separator />
                <div className="flex justify-between font-semibold">
                  <span>Grand total</span>
                  <span className="tabular-nums">{money(detail.totalCents)}</span>
                </div>
              </div>

              {detail.notes ? (
                <div className="rounded-lg bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Notes: </span>
                  {detail.notes}
                </div>
              ) : null}

              {/* Workflow actions */}
              <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                {status === "DRAFT" && canManage ? (
                  <>
                    <Button size="sm" disabled={busy !== null} onClick={() => transition("submit", undefined, "Submitted for approval")}>
                      <CheckCheck className="h-4 w-4 mr-1.5" /> Submit for approval
                    </Button>
                    <Button size="sm" variant="outline" className="text-red-600" disabled={busy !== null} onClick={() => transition("cancel", undefined, "Purchase order cancelled")}>
                      <X className="h-4 w-4 mr-1.5" /> Cancel PO
                    </Button>
                  </>
                ) : null}
                {status === "PENDING_APPROVAL" && canApprove ? (
                  <>
                    <Button size="sm" disabled={busy !== null} onClick={() => transition("approve", undefined, "Purchase order approved")}>
                      <Check className="h-4 w-4 mr-1.5" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" className="text-red-600" disabled={busy !== null} onClick={() => transition("reject", undefined, "Purchase order rejected")}>
                      <X className="h-4 w-4 mr-1.5" /> Reject
                    </Button>
                  </>
                ) : null}
                {status === "PENDING_APPROVAL" && !canApprove && canManage ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <AlertTriangle className="h-3.5 w-3.5" /> Waiting for finance approval
                  </span>
                ) : null}
                {receiving && canManage ? (
                  receiveOpen ? (
                    <>
                      <Button size="sm" disabled={busy !== null} onClick={confirmReceive}>
                        <Check className="h-4 w-4 mr-1.5" /> Confirm receipt
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setReceiveOpen(false)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" onClick={openReceive}>
                        <ClipboardCheck className="h-4 w-4 mr-1.5" /> Receive stock
                      </Button>
                      <Button size="sm" variant="outline" className="text-red-600" disabled={busy !== null} onClick={() => transition("cancel", undefined, "Purchase order cancelled")}>
                        <X className="h-4 w-4 mr-1.5" /> Cancel PO
                      </Button>
                    </>
                  )
                ) : null}
                {(status === "RECEIVED" || status === "REJECTED" || status === "CANCELLED") ? (
                  <span className="text-xs text-muted-foreground">
                    {status === "RECEIVED"
                      ? "Fully received — stock has been added to inventory."
                      : status === "REJECTED"
                        ? "This purchase order was rejected."
                        : "This purchase order was cancelled."}
                  </span>
                ) : null}
                {busy ? <span className="text-xs text-muted-foreground">Working…</span> : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
