"use client";

// MOHD.HMS ENTERPRISE — Inventory module: items, stock ledger, suppliers.
// Data comes exclusively from /api/v1/inventory*, /api/v1/suppliers — no fake data.
//
// NAVIGATION ARCHITECTURE: item create / edit / stock adjustment and supplier
// create / edit are DEDICATED PAGES routed by the hash router (ui-store pages["inventory"]):
//   []                       → this list page (Items / Movements / Suppliers tabs)
//   ["new"]                  → ItemNewPage        (Add Item)
//   [id]                     → falls back to list  (no inventory detail page exists)
//   [id, "edit"]             → ItemEditPage
//   [id, "adjust"]           → ItemAdjustPage      (Stock Adjustment)
//   ["suppliers", "new"]     → SupplierPage        (create)
//   ["suppliers", id]        → SupplierPage        (edit)
// Only the two DELETE confirmations remain AlertDialogs (confirm-only, per spec).

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
import { useToast } from "@/hooks/use-toast";
import { fmtDateTime, money } from "@/lib/hms/format";
import { PERMISSIONS, humanize, type Permission } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, Boxes, History, PackagePlus, Pencil, Plus, Trash2, Truck, Wallet } from "lucide-react";
import { ItemNewPage } from "./new-page";
import { ItemEditPage } from "./edit-page";
import { ItemAdjustPage } from "./adjust-page";
import { SupplierPage } from "./supplier-page";

// ───────────────────────────── types ─────────────────────────────

type SupplierRow = {
  id: string;
  code: string;
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  status: string;
  _count?: { items: number; purchaseOrders: number };
};

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
  supplier: { id: string; name: string } | null;
  status: string;
  low: boolean;
};

type MovementRow = {
  id: string;
  itemId: string;
  type: string;
  quantity: number;
  balanceAfter: number;
  referenceType: string;
  note: string;
  createdAt: string;
  item: { sku: string; name: string; unit: string } | null;
};

type InventoryStats = { total: number; lowStock: number; valueCents: number };

const MOVEMENT_TYPES = ["RECEIVE", "ISSUE", "RETURN", "ADJUST"] as const;

const MOVEMENT_TONE: Record<string, string> = {
  RECEIVE: "bg-emerald-100 text-emerald-800",
  ISSUE: "bg-red-100 text-red-700",
  RETURN: "bg-teal-100 text-teal-800",
  ADJUST: "bg-amber-100 text-amber-800",
};

// ───────────────────────────── helpers ─────────────────────────────

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

// ───────────────────────────── module ─────────────────────────────

export function InventoryModule() {
  const seg = useUi((s) => s.pages["inventory"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "new") return <ItemNewPage />;
  if (page.view === "edit" && page.id) return <ItemEditPage id={page.id} />;
  if (page.view === "adjust" && page.id) return <ItemAdjustPage id={page.id} />;
  if (page.view === "suppliers") {
    // ["suppliers","new"] → create · ["suppliers", id] → edit prefill.
    return <SupplierPage supplierId={page.id && page.id !== "new" ? page.id : undefined} />;
  }
  // ["new"] handled above; [id]-only (detail) falls back to the list — no
  // dedicated inventory detail page exists in this module.
  return <InventoryList />;
}

// ───────────────────────────── list page ─────────────────────────────

function InventoryList() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.inventory_manage satisfies Permission);
  const canSupplier = hasPerm(user, PERMISSIONS.purchases_manage satisfies Permission);

  const [tab, setTab] = useState("items");

  // Items
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [stats, setStats] = useState<InventoryStats | null>(null);
  const [itemsErr, setItemsErr] = useState("");
  const [itemsLoading, setItemsLoading] = useState(true);

  // Movements
  const [movements, setMovements] = useState<MovementRow[] | null>(null);
  const [movErr, setMovErr] = useState("");
  const [movLoading, setMovLoading] = useState(false);

  // Suppliers
  const [suppliers, setSuppliers] = useState<SupplierRow[] | null>(null);
  const [supErr, setSupErr] = useState("");
  const [supLoading, setSupLoading] = useState(false);

  const loadItems = useCallback(async () => {
    setItemsLoading(true);
    setItemsErr("");
    try {
      const res = await api.get<ItemRow[]>(`/api/v1/inventory${qs({ pageSize: 200 })}`);
      setItems(res.data);
      const s = (res.meta as { stats?: InventoryStats } | undefined)?.stats;
      if (s) setStats(s);
    } catch (e) {
      setItemsErr(errMessage(e));
    } finally {
      setItemsLoading(false);
    }
  }, []);

  const loadMovements = useCallback(async () => {
    setMovLoading(true);
    setMovErr("");
    try {
      const res = await api.get<MovementRow[]>(`/api/v1/inventory/movements${qs({ pageSize: 200 })}`);
      setMovements(res.data);
    } catch (e) {
      setMovErr(errMessage(e));
    } finally {
      setMovLoading(false);
    }
  }, []);

  const loadSuppliers = useCallback(async () => {
    setSupLoading(true);
    setSupErr("");
    try {
      const res = await api.get<SupplierRow[]>(`/api/v1/suppliers${qs({ pageSize: 200 })}`);
      setSuppliers(res.data);
    } catch (e) {
      setSupErr(errMessage(e));
    } finally {
      setSupLoading(false);
    }
  }, []);

  useEffect(() => {
    loadItems();
    // Suppliers load lazily when the Suppliers tab opens — the item/supplier
    // forms are dedicated pages now and fetch their own pickers.
  }, [loadItems]);

  function onTabChange(value: string) {
    setTab(value);
    if (value === "movements" && !movements && !movLoading) loadMovements();
    if (value === "suppliers" && !suppliers && !supLoading) loadSuppliers();
  }

  // ── Delete item (AlertDialog kept — confirm-only) ──
  const [deleteItem, setDeleteItem] = useState<ItemRow | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);

  async function submitDelete() {
    if (!deleteItem) return;
    setDeleteSaving(true);
    try {
      await api.del(`/api/v1/inventory/${deleteItem.id}`);
      toast({ title: "Item removed", description: `${deleteItem.sku} archived or deleted.` });
      setDeleteItem(null);
      loadItems();
    } catch (e) {
      toast({ title: "Could not remove item", description: errMessage(e), variant: "destructive" });
    } finally {
      setDeleteSaving(false);
    }
  }

  // ── Delete supplier (AlertDialog kept — confirm-only) ──
  const [deleteSupplier, setDeleteSupplier] = useState<SupplierRow | null>(null);

  async function submitDeleteSupplier() {
    if (!deleteSupplier) return;
    try {
      await api.del(`/api/v1/suppliers/${deleteSupplier.id}`);
      toast({ title: "Supplier removed" });
      setDeleteSupplier(null);
      loadSuppliers();
      loadItems();
    } catch (e) {
      toast({ title: "Could not remove supplier", description: errMessage(e), variant: "destructive" });
    }
  }

  // ── table columns ──

  const itemColumns: Column<ItemRow>[] = [
    { key: "sku", header: "SKU", value: (r) => r.sku, render: (r) => <span className="font-mono text-xs">{r.sku}</span> },
    { key: "name", header: "Item", value: (r) => r.name, render: (r) => <span className="font-medium">{r.name}</span> },
    { key: "category", header: "Category", value: (r) => r.category, hideOnMobile: true },
    {
      key: "stockQty",
      header: "Stock",
      value: (r) => r.stockQty,
      render: (r) => (
        <span className={cn("tabular-nums font-medium", r.low && "text-red-600")}>
          {r.stockQty} {r.unit}
          {r.low ? " ⚠" : ""}
        </span>
      ),
    },
    { key: "minStockQty", header: "Min", value: (r) => r.minStockQty, className: "tabular-nums", hideOnMobile: true },
    { key: "unitCostCents", header: "Unit cost", value: (r) => r.unitCostCents / 100, render: (r) => money(r.unitCostCents), className: "tabular-nums", hideOnMobile: true },
    { key: "supplier", header: "Supplier", value: (r) => r.supplier?.name ?? "", render: (r) => r.supplier?.name ?? "—", hideOnMobile: true },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "",
            sortable: false,
            className: "w-[110px] text-right",
            render: (r: ItemRow) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Adjust stock for ${r.sku}`} onClick={() => navigateTo("inventory", [r.id, "adjust"])}>
                  <PackagePlus className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Edit ${r.sku}`} onClick={() => navigateTo("inventory", [r.id, "edit"])}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-red-600 hover:text-red-700" aria-label={`Remove ${r.sku}`} onClick={() => setDeleteItem(r)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ),
          } satisfies Column<ItemRow>,
        ]
      : []),
  ];

  const movementColumns: Column<MovementRow>[] = [
    { key: "createdAt", header: "Date", value: (r) => r.createdAt, render: (r) => fmtDateTime(r.createdAt), hideOnMobile: true },
    {
      key: "item",
      header: "Item",
      value: (r) => (r.item ? `${r.item.sku} ${r.item.name}` : r.itemId),
      render: (r) => (
        <div className="min-w-0">
          <div className="font-medium truncate">{r.item?.name ?? "—"}</div>
          <div className="font-mono text-xs text-muted-foreground">{r.item?.sku}</div>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      value: (r) => r.type,
      render: (r) => <Badge variant="outline" className={cn("border-transparent", MOVEMENT_TONE[r.type])}>{humanize(r.type)}</Badge>,
    },
    {
      key: "quantity",
      header: "Qty",
      value: (r) => r.quantity,
      render: (r) => (
        <span className={cn("tabular-nums font-medium", r.quantity >= 0 ? "text-emerald-600" : "text-red-600")}>
          {r.quantity >= 0 ? "+" : ""}
          {r.quantity}
        </span>
      ),
    },
    { key: "balanceAfter", header: "Balance", value: (r) => r.balanceAfter, className: "tabular-nums" },
    {
      key: "note",
      header: "Note",
      value: (r) => r.note,
      render: (r) => <span className="text-muted-foreground line-clamp-1 max-w-[220px]">{r.note || r.referenceType.toLowerCase()}</span>,
      hideOnMobile: true,
    },
  ];

  const supplierColumns: Column<SupplierRow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: "name", header: "Supplier", value: (r) => r.name, render: (r) => <span className="font-medium">{r.name}</span> },
    { key: "contactPerson", header: "Contact", value: (r) => r.contactPerson, render: (r) => r.contactPerson || "—", hideOnMobile: true },
    { key: "phone", header: "Phone", value: (r) => r.phone, render: (r) => r.phone || "—", hideOnMobile: true },
    { key: "email", header: "Email", value: (r) => r.email, render: (r) => r.email || "—", hideOnMobile: true },
    { key: "items", header: "Items", value: (r) => r._count?.items ?? 0, className: "tabular-nums" },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    ...(canSupplier
      ? [
          {
            key: "actions",
            header: "",
            sortable: false,
            className: "w-[90px] text-right",
            render: (r: SupplierRow) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Edit ${r.name}`} onClick={() => navigateTo("inventory", ["suppliers", r.id])}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-red-600 hover:text-red-700" aria-label={`Remove ${r.name}`} onClick={() => setDeleteSupplier(r)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ),
          } satisfies Column<SupplierRow>,
        ]
      : []),
  ];

  // ── render ──

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle="Stock items, movements and suppliers"
        actions={
          canManage ? (
            <Button onClick={() => navigateTo("inventory", ["new"])}>
              <Plus className="h-4 w-4 mr-1.5" /> Add item
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-5">
        <StatCard title="Total items" value={stats ? stats.total : "—"} sub="Active items" icon={<Boxes className="h-5 w-5" />} loading={!stats} />
        <StatCard title="Low stock" value={stats ? stats.lowStock : "—"} sub="At or below minimum" icon={<AlertTriangle className="h-5 w-5" />} tone={stats && stats.lowStock > 0 ? "warning" : "default"} loading={!stats} />
        <StatCard title="Stock value" value={stats ? money(stats.valueCents) : "—"} sub="Σ qty × unit cost" icon={<Wallet className="h-5 w-5" />} tone="success" loading={!stats} />
      </div>

      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList className="mb-4">
          <TabsTrigger value="items">Items</TabsTrigger>
          <TabsTrigger value="movements" className="gap-1.5">
            <History className="h-3.5 w-3.5" /> Movements
          </TabsTrigger>
          <TabsTrigger value="suppliers" className="gap-1.5">
            <Truck className="h-3.5 w-3.5" /> Suppliers
          </TabsTrigger>
        </TabsList>

        <TabsContent value="items" className="mt-0">
          {itemsLoading && !items ? (
            <LoadingState label="Loading inventory…" />
          ) : itemsErr ? (
            <ErrorState message={itemsErr} onRetry={loadItems} />
          ) : items && items.length === 0 ? (
            <EmptyState
              title="No inventory items"
              hint={canManage ? "Add your first item to start tracking stock." : undefined}
              action={
                canManage ? (
                  <Button variant="outline" onClick={() => navigateTo("inventory", ["new"])}>
                    <Plus className="h-4 w-4 mr-1.5" /> Add item
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              columns={itemColumns}
              rows={items ?? []}
              rowKey={(r) => r.id}
              searchPlaceholder="Search SKU or name…"
              emptyTitle="No inventory items match"
              exportName="inventory"
              filters={[
                {
                  key: "low",
                  label: "Stock level",
                  options: [{ value: "low", label: "Low stock only" }],
                  match: (r, v) => (v === "low" ? r.low : true),
                },
                {
                  key: "status",
                  label: "Status",
                  options: [
                    { value: "ACTIVE", label: "Active" },
                    { value: "INACTIVE", label: "Inactive" },
                  ],
                  match: (r, v) => r.status === v,
                },
              ]}
            />
          )}
        </TabsContent>

        <TabsContent value="movements" className="mt-0">
          {movLoading && !movements ? (
            <LoadingState label="Loading stock movements…" />
          ) : movErr ? (
            <ErrorState message={movErr} onRetry={loadMovements} />
          ) : movements && movements.length === 0 ? (
            <EmptyState title="No stock movements yet" hint="Movements appear when stock is received, issued, returned or adjusted." />
          ) : (
            <DataTable
              columns={movementColumns}
              rows={movements ?? []}
              rowKey={(r) => r.id}
              searchPlaceholder="Search item, note…"
              emptyTitle="No stock movements"
              exportName="inventory-movements"
              filters={[
                {
                  key: "type",
                  label: "Movement type",
                  options: MOVEMENT_TYPES.map((t) => ({ value: t, label: humanize(t) })),
                  match: (r, v) => r.type === v,
                },
              ]}
            />
          )}
        </TabsContent>

        <TabsContent value="suppliers" className="mt-0">
          <div className="mb-3 flex justify-end">
            {canSupplier ? (
              <Button variant="outline" onClick={() => navigateTo("inventory", ["suppliers", "new"])}>
                <Plus className="h-4 w-4 mr-1.5" /> Add supplier
              </Button>
            ) : null}
          </div>
          {supLoading && !suppliers ? (
            <LoadingState label="Loading suppliers…" />
          ) : supErr ? (
            <ErrorState message={supErr} onRetry={loadSuppliers} />
          ) : suppliers && suppliers.length === 0 ? (
            <EmptyState
              title="No suppliers"
              hint={canSupplier ? "Add a supplier to start raising purchase orders." : undefined}
              action={
                canSupplier ? (
                  <Button variant="outline" onClick={() => navigateTo("inventory", ["suppliers", "new"])}>
                    <Plus className="h-4 w-4 mr-1.5" /> Add supplier
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              columns={supplierColumns}
              rows={suppliers ?? []}
              rowKey={(r) => r.id}
              searchPlaceholder="Search suppliers…"
              emptyTitle="No suppliers match"
              exportName="suppliers"
              filters={[
                {
                  key: "status",
                  label: "Status",
                  options: [
                    { value: "ACTIVE", label: "Active" },
                    { value: "INACTIVE", label: "Inactive" },
                  ],
                  match: (r, v) => r.status === v,
                },
              ]}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Delete item confirm (AlertDialog — confirm-only, stays a dialog) */}
      <AlertDialog open={!!deleteItem} onOpenChange={(o) => !o && setDeleteItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deleteItem?.sku}?</AlertDialogTitle>
            <AlertDialogDescription>
              Items with stock history are archived (status Inactive) instead of deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep item</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={deleteSaving}
              onClick={(e) => {
                e.preventDefault();
                submitDelete();
              }}
            >
              {deleteSaving ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete supplier confirm (AlertDialog — confirm-only, stays a dialog) */}
      <AlertDialog open={!!deleteSupplier} onOpenChange={(o) => !o && setDeleteSupplier(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deleteSupplier?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Suppliers linked to items, purchase orders or expenses are archived (status Inactive) instead of deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep supplier</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={(e) => {
                e.preventDefault();
                submitDeleteSupplier();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
