// One-off backfill for the Inventory spec implementation:
// 1. MAIN warehouse  2. nameNorm on existing items  3. WarehouseStock rows
// 4. inventory behavior settings  5. WorkOrderMaterial status defaults are schema-level.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  // 1. MAIN warehouse (idempotent)
  let main = await db.warehouse.findUnique({ where: { code: "MAIN" } });
  if (!main) {
    main = await db.warehouse.create({ data: { code: "MAIN", name: "Main Warehouse" } });
    console.log("created warehouse MAIN", main.id);
  }

  // 2/3. Backfill items: nameNorm + default warehouse + per-warehouse stock rows
  const items = await db.inventoryItem.findMany({ include: { stocks: true } });
  for (const it of items) {
    const patch: Record<string, unknown> = {};
    if (!it.nameNorm) patch.nameNorm = norm(it.name);
    if (!it.warehouseId) patch.warehouseId = main.id;
    if (Object.keys(patch).length) {
      await db.inventoryItem.update({ where: { id: it.id }, data: patch });
    }
    const has = it.stocks.find((s) => s.warehouseId === main.id);
    if (!has && it.stockQty > 0) {
      await db.warehouseStock.create({ data: { itemId: it.id, warehouseId: main.id, qty: it.stockQty } });
    } else if (has && has.qty !== it.stockQty) {
      await db.warehouseStock.update({ where: { id: has.id }, data: { qty: it.stockQty } });
    }
  }
  console.log("backfilled items:", items.length);

  // 4. Behavior settings (defaults OFF / AVERAGE / disallow negative)
  const settings: Array<[string, string]> = [
    ["inventory_reservation_on_quotation_approval", "false"],
    ["inventory_valuation_method", "AVERAGE"],
    ["inventory_negative_stock", "false"],
  ];
  for (const [key, value] of settings) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: {} });
  }
  console.log("settings ensured");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
