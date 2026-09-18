"use client";

// MOHD.HMS ENTERPRISE — Purchase Order Detail (dedicated full page, purchases/{id}).
// Replaces the former detail dialog: same data, same workflow actions, same APIs
// (GET /api/v1/purchases/{id}, POST /api/v1/purchases/{id}/transition) — no popup.
// The goods-receipt sub-form was NEVER a nested dialog: it stays INLINE on this
// page (receive qty inputs appear in the items table when receiving is open).

import { useCallback, useEffect, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { PageShell } from "@/components/hms/shared/page-shell";
import { LoadingState, EmptyState, ErrorState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { WorkflowTimeline } from "@/components/hms/shared/workflow-timeline";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { fmtDate, money } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle, Check, CheckCheck, ClipboardCheck, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

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

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

function num(value: string, fallback = 0): number {
  const n = parseFloat(value);
  return isFinite(n) ? n : fallback;
}

export function PurchaseDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.purchases_manage satisfies Permission);
  const canApprove = hasPerm(user, PERMISSIONS.purchases_approve satisfies Permission);

  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Inline receive sub-form (never a nested dialog — kept exactly as before).
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await api.get<PurchaseOrderDetail>(`/api/v1/purchases/${id}`);
      setDetail(res.data);
    } catch (e) {
      setLoadError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const transition = useCallback(async (action: string, extra?: Record<string, unknown>, successMsg?: string) => {
    setBusy(action);
    try {
      const res = await api.post<PurchaseOrderDetail>(`/api/v1/purchases/${id}/transition`, { action, ...extra });
      // Refresh with the authoritative server record after each transition.
      setDetail(res.data);
      toast({ title: successMsg ?? "Purchase order updated", description: `${res.data.code} → ${res.data.status.replaceAll("_", " ").toLowerCase()}` });
      setReceiveOpen(false);
      setReceiveQty({});
    } catch (e) {
      toast({ title: "Action failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }, [id, toast]);

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

  const status = detail?.status;
  const receiving = status === "APPROVED" || status === "PARTIALLY_RECEIVED";

  if (loading && !detail) {
    return (
      <PageShell backLabel="Back to Purchases" backHref="#/purchases" crumbs={[{ label: "Purchases", href: "#/purchases" }, { label: "Purchase order" }]} title="Purchase order">
        <LoadingState label="Loading purchase order…" rows={5} />
      </PageShell>
    );
  }

  if (loadError) {
    return (
      <PageShell backLabel="Back to Purchases" backHref="#/purchases" crumbs={[{ label: "Purchases", href: "#/purchases" }, { label: "Purchase order" }]} title="Purchase order">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!detail) {
    return (
      <PageShell backLabel="Back to Purchases" backHref="#/purchases" crumbs={[{ label: "Purchases", href: "#/purchases" }, { label: "Purchase order" }]} title="Purchase order">
        <EmptyState title="Purchase order not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Purchases"
      backHref="#/purchases"
      crumbs={[{ label: "Purchases", href: "#/purchases" }, { label: detail.code }]}
      title={detail.code}
      description={
        `${detail.supplier?.name ?? "—"} · ordered ${fmtDate(detail.orderDate)}` +
        (detail.expectedDate ? ` · expected ${fmtDate(detail.expectedDate)}` : "") +
        (detail.receivedAt ? ` · received ${fmtDate(detail.receivedAt)}` : "")
      }
      actions={<StatusBadge status={detail.status} />}
    >
      <div className="space-y-4 max-w-4xl">
        {/* Supplier / dates summary */}
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 grid gap-4 text-sm sm:grid-cols-3">
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Supplier</p>
            <p className="font-medium">{detail.supplier?.name ?? "—"}</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Order / expected dates</p>
            <p>
              {fmtDate(detail.orderDate)}
              {detail.expectedDate ? ` → ${fmtDate(detail.expectedDate)}` : ""}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs uppercase tracking-wide">Approval / receipt</p>
            <p>
              {detail.approvedAt ? `Approved ${fmtDate(detail.approvedAt)}` : "Not approved yet"}
              {detail.receivedAt ? ` · Received ${fmtDate(detail.receivedAt)}` : ""}
            </p>
          </div>
        </div>

        {/* Items table (+ inline receive qty column while receiving) */}
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4">
          <div className="rounded-xl border overflow-x-auto hms-scroll">
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

          {/* Totals */}
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
        </div>

        {/* Workflow actions — same visibility rules as the former dialog */}
        <div className="rounded-xl border bg-card shadow-sm p-4">
          <div className="flex flex-wrap items-center gap-2">
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
        </div>
      </div>
      <WorkflowTimeline resourceType="PURCHASE_ORDER" resourceId={detail.id} className="mt-6" />
    </PageShell>
  );
}
