// MOHD.HMS ENTERPRISE — Inventory reference data (Inventory spec §21/§28/§29).
// GET /api/v1/inventory/categories — categories in use + suggested list, UOMs, warehouses.
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS, UOMS, ITEM_TYPES, INVENTORY_CATEGORIES } from "@/lib/hms/constants";

export const GET = handler(
  async () => {
    const [grouped, warehouses] = await Promise.all([
      db.inventoryItem.groupBy({ by: ["category"], _count: { _all: true }, orderBy: { category: "asc" } }),
      db.warehouse.findMany({ where: { status: "ACTIVE" }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    ]);
    const inUse = grouped.map((g) => g.category).filter(Boolean);
    const suggested = INVENTORY_CATEGORIES.filter((c) => !inUse.includes(c));
    return ok({
      categories: { inUse, suggested, all: [...inUse, ...suggested] },
      uoms: UOMS,
      itemTypes: ITEM_TYPES,
      warehouses,
    });
  },
  { permission: PERMISSIONS.inventory_read }
);
