"use client";
// MOHD.HMS ENTERPRISE — THE one reusable inventory item picker (Inventory spec §5/§6/§7/§33/§34/§45/§60).
//
// Shared by Quotations, Work Orders, Purchases, PM parts and Inventory:
//   1. Search the canonical catalog (/inventory/search).
//   2. Pick an existing item → onSelect(item).
//   3. No match? Enter a custom item → backend duplicate detection
//      (POST /inventory/resolve-item without confirmNew) →
//      shows possible matches with [Use Existing], or
//   4. [Create New Inventory Item] → resolve-item confirmNew:true → the
//      canonical item is created and returned — linked modules attach its id
//      immediately; it appears in Inventory/Quotations/Work Orders/Purchases
//      everywhere with no manual sync (§60/§61).

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { useSession } from "@/components/hms/session";
import { money } from "@/lib/hms/format";
import { ITEM_TYPES, UOMS } from "@/lib/hms/constants";
import { PackageSearch, PackagePlus, Check, ChevronsUpDown, AlertTriangle } from "lucide-react";

export type PickedItem = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  category?: string;
  stockQty?: number;
  reservedQty?: number;
  available?: number;
  unitCostCents?: number;
  sellingPriceCents?: number;
  stockType?: string;
};

type SearchRow = PickedItem & { supplier?: { id: string; name: string } | null };

type MatchRow = {
  id: string;
  sku: string;
  name: string;
  category: string;
  brand: string;
  partNumber: string;
  unit: string;
  stockQty: number;
  unitCostCents: number;
  matchedBy: string[];
  score: number;
};

const CUSTOM = "__custom__";

export function ItemPicker({
  value,
  onSelect,
  onCleared,
  placeholder = "Search inventory… or add a new item",
  showAvailability = true,
  className,
  disabled,
}: {
  value?: PickedItem | null;
  onSelect: (item: PickedItem) => void;
  onCleared?: () => void;
  placeholder?: string;
  /** §45/§46 — show On Hand / Available in the result rows. */
  showAvailability?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const canCreate = useMemo(() => {
    if (!user) return false;
    const p = user.permissions ?? [];
    return p.includes("inventory.manage") || p.includes("quotations.manage") || p.includes("work_orders.update") || p.includes("purchases.manage") || p.includes("pm.manage");
  }, [user]);

  const search = async (q: string) => {
    setLoading(true);
    try {
      const res = await api.get<{ items: SearchRow[] }>(`/inventory/search?q=${encodeURIComponent(q)}&take=15`);
      setRows((res.data.items ?? []) as SearchRow[]);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void search("");
  }, [open]);

  const pick = (row: SearchRow) => {
    onSelect(row);
    setOpen(false);
  };

  /** §33 flow — try a controlled creation; 409 ITEM_MATCHES means duplicates exist. */
  const submitCreate = async (payload: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await api.post<{ status: string; item?: PickedItem; matchedBy?: string[] }>("/inventory/resolve-item", payload);
      if (res.data.status === "CREATED" || res.data.status === "EXISTING") {
        const item = res.data.item!;
        toast({
          title: res.data.status === "CREATED" ? "Inventory item created" : "Existing item used",
          description: res.data.status === "CREATED"
            ? `${item.sku} — now available everywhere in the system.`
            : `${item.sku} matched an existing item (duplicate prevented).`,
        });
        setCreateOpen(false);
        setMatches(null);
        onSelect({ ...item, unitCostCents: (item as { unitCostCents?: number }).unitCostCents ?? 0 });
        setOpen(false);
      }
    } catch (e: unknown) {
      const err = e as { code?: string; details?: { matches?: MatchRow[] }; message?: string };
      if (err.code === "ITEM_MATCHES" && err.details?.matches) {
        setMatches(err.details.matches); // §34 — show matches + [Use Existing]
      } else {
        toast({ title: "Could not create item", description: err.message ?? "Please try again.", variant: "destructive" });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={className}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal" disabled={disabled}>
            {value ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{value.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{value.sku}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[380px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search name, SKU, part number, barcode…" onValueChange={(q) => void search(q)} />
            <CommandList className="max-h-72">
              {loading && <div className="py-4 text-center text-sm text-muted-foreground">Searching…</div>}
              {!loading && rows.length === 0 && (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground">No inventory item found.</div>
              )}
              <CommandGroup>
                {rows.map((r) => (
                  <CommandItem key={r.id} value={r.id} onSelect={() => pick(r)} className="flex items-start justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{r.name}</div>
                      <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                        <span className="font-mono">{r.sku}</span>
                        {r.category && <span>{r.category}</span>}
                        {r.unit && <span>UOM {r.unit}</span>}
                        {showAvailability && r.stockType !== "NON_STOCK" && (
                          <span>
                            On hand {r.stockQty ?? 0}
                            {typeof r.reservedQty === "number" && r.reservedQty > 0 ? ` · available ${r.available ?? 0}` : ""}
                          </span>
                        )}
                      </div>
                    </div>
                    <Check className="mt-1 h-4 w-4 shrink-0 opacity-0" />
                  </CommandItem>
                ))}
              </CommandGroup>
              {canCreate && (
                <CommandGroup>
                  <CommandItem
                    value="__create_new__"
                    onSelect={() => {
                      setOpen(false);
                      setMatches(null);
                      setCreateOpen(true);
                    }}
                    className="text-primary"
                  >
                    <PackagePlus className="mr-2 h-4 w-4" />
                    + Create New Inventory Item
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value && onCleared && (
        <Button variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs text-muted-foreground" onClick={onCleared}>
          Clear item (make it a custom line)
        </Button>
      )}

      <CreateItemDialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setMatches(null);
        }}
        matches={matches}
        saving={saving}
        onSubmit={submitCreate}
        onUseExisting={(m) => {
          setCreateOpen(false);
          setMatches(null);
          onSelect({
            id: m.id,
            sku: m.sku,
            name: m.name,
            unit: m.unit,
            category: m.category,
            stockQty: m.stockQty,
            unitCostCents: m.unitCostCents,
          });
        }}
      />
    </div>
  );
}

/** §35 — inline item creation modal (professional, consistent with the design system). */
export function CreateItemDialog({
  open,
  onOpenChange,
  matches,
  saving,
  onSubmit,
  onUseExisting,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  matches: MatchRow[] | null;
  saving: boolean;
  onSubmit: (payload: Record<string, unknown>) => void;
  onUseExisting: (m: MatchRow) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("GENERAL");
  const [unit, setUnit] = useState("PCS");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [itemType, setItemType] = useState("STOCK");
  const [minStockQty, setMinStockQty] = useState("0");
  const [reorderLevel, setReorderLevel] = useState("0");
  const [unitCost, setUnitCost] = useState("0");

  useEffect(() => {
    if (open) {
      setName("");
      setBrand("");
      setModel("");
      setPartNumber("");
    }
  }, [open]);

  const submit = () => {
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      category: category.trim() || "GENERAL",
      unit,
      brand: brand.trim() || undefined,
      model: model.trim() || undefined,
      partNumber: partNumber.trim() || undefined,
      itemType,
      minStockQty: Number(minStockQty) || 0,
      reorderLevel: Number(reorderLevel) || 0,
      unitCostCents: Math.round((Number(unitCost) || 0) * 100),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackagePlus className="h-5 w-5 text-primary" /> Create New Inventory Item
          </DialogTitle>
          <DialogDescription>
            The item is created once in the central catalog and immediately available in Quotations, Work Orders, Purchases and PM — no duplicate catalogs.
          </DialogDescription>
        </DialogHeader>

        {matches && matches.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" /> Possible existing items found
            </div>
            <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
              {matches.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1.5">
                  <div className="min-w-0 text-xs">
                    <div className="truncate font-medium">{m.name}</div>
                    <div className="text-muted-foreground">
                      <span className="font-mono">{m.sku}</span>
                      {m.brand ? ` · ${m.brand}` : ""} · UOM {m.unit} · stock {m.stockQty} {m.matchedBy?.length ? `· matched by ${m.matchedBy.join(", ").toLowerCase().replace(/_/g, " ")}` : ""}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => onUseExisting(m)}>
                    Use Existing
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">Not a match? Confirm the details below to create a new item.</div>
          </div>
        )}

        <div className="grid max-h-[50vh] gap-3 overflow-y-auto pr-1">
          <div className="grid gap-1.5">
            <Label htmlFor="ip-name">Item Name *</Label>
            <Input id="ip-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Copper Pipe 3/8&quot;" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Category</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} list="ip-cats" />
              <datalist id="ip-cats">
                {["HVAC", "ELECTRICAL", "PLUMBING", "FIRE_PROTECTION", "GENERATOR", "MECHANICAL", "CIVIL", "CLEANING", "PEST_CONTROL", "LANDSCAPE", "GENERAL", "TOOLS", "CONSUMABLES", "SPARE_PARTS"].map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-1.5">
              <Label>Unit of Measure</Label>
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {UOMS.map((u) => (
                    <SelectItem key={u} value={u}>{u}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Brand</Label>
              <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="ABC" />
            </div>
            <div className="grid gap-1.5">
              <Label>Part Number</Label>
              <Input value={partNumber} onChange={(e) => setPartNumber(e.target.value)} placeholder="ABC-CP-38" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Item Type</Label>
              <Select value={itemType} onValueChange={setItemType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ITEM_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Unit Cost (RM)</Label>
              <Input type="number" min="0" step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Minimum Stock</Label>
              <Input type="number" min="0" value={minStockQty} onChange={(e) => setMinStockQty(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Reorder Level</Label>
              <Input type="number" min="0" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !name.trim()}>
            {saving ? "Checking duplicates…" : "Create Inventory Item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
