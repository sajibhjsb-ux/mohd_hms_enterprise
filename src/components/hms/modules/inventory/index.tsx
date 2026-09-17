"use client";

// MOHD.HMS ENTERPRISE — Inventory module: items, stock ledger, suppliers.
// Data comes exclusively from /api/v1/inventory*, /api/v1/suppliers — no fake data.

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
import { useDraft } from "@/hooks/use-draft";
import { useToast } from "@/hooks/use-toast";
import { fromCents, fmtDateTime, money, toCents } from "@/lib/hms/format";
import { PERMISSIONS, humanize, type Permission } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

function num(value: string, fallback = 0): number {
  const n = parseFloat(value);
  return isFinite(n) ? n : fallback;
}

// ───────────────────────────── module ─────────────────────────────

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

export function InventoryModule() {
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
    loadSuppliers(); // needed for item create/edit supplier pickers
  }, [loadItems, loadSuppliers]);

  function onTabChange(value: string) {
    setTab(value);
    if (value === "movements" && !movements && !movLoading) loadMovements();
    if (value === "suppliers" && !suppliers && !supLoading) loadSuppliers();
  }

  // ── Add item dialog (draft-protected) ──
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const draft = useDraft<ItemDraft>({ formKey: "inventory.item.create", initial: BLANK_ITEM_DRAFT });

  async function submitItem() {
    const v = draft.value;
    if (!v.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api.post<ItemRow>("/api/v1/inventory", {
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
      setAddOpen(false);
      loadItems();
    } catch (e) {
      toast({ title: "Could not create item", description: errMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── Edit item dialog ──
  const [editItem, setEditItem] = useState<ItemRow | null>(null);
  const [editForm, setEditForm] = useState({ name: "", category: "", unit: "", minStockQty: "", unitCost: "", supplierId: "", status: "ACTIVE" });
  const [editSaving, setEditSaving] = useState(false);

  function openEdit(item: ItemRow) {
    setEditForm({
      name: item.name,
      category: item.category,
      unit: item.unit,
      minStockQty: String(item.minStockQty),
      unitCost: fromCents(item.unitCostCents),
      supplierId: item.supplierId ?? "NONE",
      status: item.status,
    });
    setEditItem(item);
  }

  async function submitEdit() {
    if (!editItem) return;
    setEditSaving(true);
    try {
      await api.patch<ItemRow>(`/api/v1/inventory/${editItem.id}`, {
        name: editForm.name.trim(),
        category: editForm.category.trim(),
        unit: editForm.unit.trim(),
        minStockQty: num(editForm.minStockQty),
        unitCost: num(editForm.unitCost),
        supplierId: editForm.supplierId === "NONE" ? null : editForm.supplierId,
        status: editForm.status,
      });
      toast({ title: "Item updated", description: editItem.sku });
      setEditItem(null);
      loadItems();
    } catch (e) {
      toast({ title: "Could not update item", description: errMessage(e), variant: "destructive" });
    } finally {
      setEditSaving(false);
    }
  }

  // ── Adjust stock dialog ──
  const [adjustItem, setAdjustItem] = useState<ItemRow | null>(null);
  const [adjustType, setAdjustType] = useState<(typeof MOVEMENT_TYPES)[number]>("RECEIVE");
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjustSaving, setAdjustSaving] = useState(false);

  function openAdjust(item: ItemRow) {
    setAdjustType("RECEIVE");
    setAdjustQty("");
    setAdjustNote("");
    setAdjustItem(item);
  }

  async function submitAdjust() {
    if (!adjustItem) return;
    const qty = num(adjustQty, NaN);
    if (!isFinite(qty) || qty === 0 || (adjustType !== "ADJUST" && qty <= 0)) {
      toast({
        title: "Invalid quantity",
        description: adjustType === "ADJUST" ? "Enter a non-zero signed delta (e.g. -2 or 5)." : "Enter a positive quantity.",
        variant: "destructive",
      });
      return;
    }
    setAdjustSaving(true);
    try {
      const res = await api.post<{ item: ItemRow }>(`/api/v1/inventory/${adjustItem.id}/movement`, {
        type: adjustType,
        quantity: qty,
        note: adjustNote.trim() || undefined,
      });
      toast({
        title: "Stock updated",
        description: `${adjustItem.sku} — new balance ${res.data.item.stockQty} ${adjustItem.unit}.`,
      });
      setAdjustItem(null);
      loadItems();
      if (movements) loadMovements();
    } catch (e) {
      toast({ title: "Could not record movement", description: errMessage(e), variant: "destructive" });
    } finally {
      setAdjustSaving(false);
    }
  }

  // ── Delete item ──
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

  // ── Supplier create/edit dialog ──
  const [supDialog, setSupDialog] = useState<{ open: boolean; supplier: SupplierRow | null }>({ open: false, supplier: null });
  const [supForm, setSupForm] = useState({ name: "", contactPerson: "", email: "", phone: "", address: "" });
  const [supSaving, setSupSaving] = useState(false);
  const [deleteSupplier, setDeleteSupplier] = useState<SupplierRow | null>(null);

  function openSupplierDialog(supplier: SupplierRow | null) {
    setSupForm(
      supplier
        ? { name: supplier.name, contactPerson: supplier.contactPerson, email: supplier.email, phone: supplier.phone, address: supplier.address }
        : { name: "", contactPerson: "", email: "", phone: "", address: "" }
    );
    setSupDialog({ open: true, supplier });
  }

  async function submitSupplier() {
    if (!supForm.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setSupSaving(true);
    try {
      if (supDialog.supplier) {
        await api.patch(`/api/v1/suppliers/${supDialog.supplier.id}`, supForm);
        toast({ title: "Supplier updated" });
      } else {
        await api.post("/api/v1/suppliers", supForm);
        toast({ title: "Supplier created" });
      }
      setSupDialog({ open: false, supplier: null });
      loadSuppliers();
    } catch (e) {
      toast({ title: "Could not save supplier", description: errMessage(e), variant: "destructive" });
    } finally {
      setSupSaving(false);
    }
  }

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
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Adjust stock for ${r.sku}`} onClick={() => openAdjust(r)}>
                  <PackagePlus className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Edit ${r.sku}`} onClick={() => openEdit(r)}>
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
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Edit ${r.name}`} onClick={() => openSupplierDialog(r)}>
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
            <Button onClick={() => setAddOpen(true)}>
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
          ) : (
            <DataTable
              columns={itemColumns}
              rows={items ?? []}
              rowKey={(r) => r.id}
              searchPlaceholder="Search SKU or name…"
              emptyTitle="No inventory items"
              emptyHint={canManage ? "Add your first item to start tracking stock." : undefined}
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
              <Button variant="outline" onClick={() => openSupplierDialog(null)}>
                <Plus className="h-4 w-4 mr-1.5" /> Add supplier
              </Button>
            ) : null}
          </div>
          {supLoading && !suppliers ? (
            <LoadingState label="Loading suppliers…" />
          ) : supErr ? (
            <ErrorState message={supErr} onRetry={loadSuppliers} />
          ) : (
            <DataTable
              columns={supplierColumns}
              rows={suppliers ?? []}
              rowKey={(r) => r.id}
              searchPlaceholder="Search suppliers…"
              emptyTitle="No suppliers"
              emptyHint={canSupplier ? "Add a supplier to start raising purchase orders." : undefined}
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

      {/* Add item dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add inventory item</DialogTitle>
            <DialogDescription>SKU is generated automatically when left blank.</DialogDescription>
          </DialogHeader>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitItem} disabled={saving}>
              {saving ? "Saving…" : "Create item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit item dialog */}
      <Dialog open={!!editItem} onOpenChange={(o) => !o && setEditItem(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit item {editItem?.sku}</DialogTitle>
            <DialogDescription>Stock quantity is changed via stock movements, not here.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Item name *" className="sm:col-span-2">
              <Input value={editForm.name} onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))} />
            </Field>
            <Field label="Category">
              <Input value={editForm.category} onChange={(e) => setEditForm((p) => ({ ...p, category: e.target.value }))} />
            </Field>
            <Field label="Unit">
              <Input value={editForm.unit} onChange={(e) => setEditForm((p) => ({ ...p, unit: e.target.value }))} />
            </Field>
            <Field label="Minimum stock qty">
              <Input type="number" min="0" step="any" value={editForm.minStockQty} onChange={(e) => setEditForm((p) => ({ ...p, minStockQty: e.target.value }))} />
            </Field>
            <Field label="Unit cost (RM)">
              <Input type="number" min="0" step="0.01" value={editForm.unitCost} onChange={(e) => setEditForm((p) => ({ ...p, unitCost: e.target.value }))} />
            </Field>
            <Field label="Supplier">
              <Select value={editForm.supplierId || "NONE"} onValueChange={(v) => setEditForm((p) => ({ ...p, supplierId: v === "NONE" ? "NONE" : v }))}>
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
            <Field label="Status">
              <Select value={editForm.status} onValueChange={(v) => setEditForm((p) => ({ ...p, status: v }))}>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}>
              Cancel
            </Button>
            <Button onClick={submitEdit} disabled={editSaving}>
              {editSaving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Adjust stock dialog */}
      <Dialog open={!!adjustItem} onOpenChange={(o) => !o && setAdjustItem(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Adjust stock — {adjustItem?.sku}</DialogTitle>
            <DialogDescription>
              Current balance: {adjustItem ? `${adjustItem.stockQty} ${adjustItem.unit}` : "—"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Movement type">
              <Select value={adjustType} onValueChange={(v) => setAdjustType(v as (typeof MOVEMENT_TYPES)[number])}>
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
            <Field label={adjustType === "ADJUST" ? "Signed delta (e.g. -2 or 5)" : "Quantity"}>
              <Input
                type="number"
                step="any"
                value={adjustQty}
                onChange={(e) => setAdjustQty(e.target.value)}
                placeholder={adjustType === "ADJUST" ? "-2" : "1"}
              />
            </Field>
            <Field label="Note">
              <Textarea value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="Reason / reference (optional)" rows={2} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustItem(null)}>
              Cancel
            </Button>
            <Button onClick={submitAdjust} disabled={adjustSaving}>
              {adjustSaving ? "Recording…" : "Record movement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete item confirm */}
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

      {/* Supplier create/edit dialog */}
      <Dialog open={supDialog.open} onOpenChange={(o) => !o && setSupDialog({ open: false, supplier: null })}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{supDialog.supplier ? `Edit ${supDialog.supplier.name}` : "Add supplier"}</DialogTitle>
            <DialogDescription>Code is generated automatically for new suppliers.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Supplier name *" className="sm:col-span-2">
              <Input value={supForm.name} onChange={(e) => setSupForm((p) => ({ ...p, name: e.target.value }))} />
            </Field>
            <Field label="Contact person">
              <Input value={supForm.contactPerson} onChange={(e) => setSupForm((p) => ({ ...p, contactPerson: e.target.value }))} />
            </Field>
            <Field label="Phone">
              <Input value={supForm.phone} onChange={(e) => setSupForm((p) => ({ ...p, phone: e.target.value }))} />
            </Field>
            <Field label="Email">
              <Input type="email" value={supForm.email} onChange={(e) => setSupForm((p) => ({ ...p, email: e.target.value }))} />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Textarea value={supForm.address} onChange={(e) => setSupForm((p) => ({ ...p, address: e.target.value }))} rows={2} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSupDialog({ open: false, supplier: null })}>
              Cancel
            </Button>
            <Button onClick={submitSupplier} disabled={supSaving}>
              {supSaving ? "Saving…" : supDialog.supplier ? "Save changes" : "Create supplier"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete supplier confirm */}
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
