"use client";

// MOHD.HMS ENTERPRISE — Purchases module: purchase orders + approval workflow.
// Data comes exclusively from /api/v1/purchases, /api/v1/suppliers, /api/v1/inventory.
//
// NAVIGATION ARCHITECTURE: PO create and detail are DEDICATED PAGES routed by the
// hash router (ui-store pages["purchases"]):
//   []      → this list page
//   ["new"] → PurchaseNewPage
//   [id]    → PurchaseDetailPage (workflow actions + inline goods receipt live there)
// The goods-receipt sub-form was never a nested dialog and stays inline on the
// detail page. No confirmation dialogs existed on this module.

import { useCallback, useEffect, useState } from "react";
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
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { fmtDate, money } from "@/lib/hms/format";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Plus, ShoppingCart, ClipboardCheck, Hourglass } from "lucide-react";
import { PurchaseNewPage } from "./new-page";
import { PurchaseDetailPage } from "./detail-page";

// ───────────────────────────── types ─────────────────────────────

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

type PurchaseStats = { awaitingApproval: number; approvedOpen: number; receivedThisMonth: number };

// ───────────────────────────── helpers ─────────────────────────────

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

// ───────────────────────────── module ─────────────────────────────

export function PurchasesModule() {
  const seg = useUi((s) => s.pages["purchases"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "new") return <PurchaseNewPage />;
  if (page.view === "detail" && page.id) return <PurchaseDetailPage id={page.id} />;
  return <PurchasesList />;
}

// ───────────────────────────── list page ─────────────────────────────

function PurchasesList() {
  const { user } = useSession();
  const canManage = hasPerm(user, PERMISSIONS.purchases_manage satisfies Permission);

  // List + stats
  const [pos, setPos] = useState<PurchaseOrderListRow[] | null>(null);
  const [stats, setStats] = useState<PurchaseStats | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

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
    // Supplier/inventory reference pickers now load on the dedicated new-PO page.
  }, [loadPos]);

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

  return (
    <div>
      <PageHeader
        title="Purchases"
        subtitle="Purchase orders, approvals and goods receipt"
        actions={
          canManage ? (
            <Button onClick={() => navigateTo("purchases", ["new"])}>
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
              <Button onClick={() => navigateTo("purchases", ["new"])}>
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
          onRowClick={(r) => navigateTo("purchases", [r.id])}
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
    </div>
  );
}
