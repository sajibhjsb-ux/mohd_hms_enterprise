// MOHD.HMS ENTERPRISE — Professional inventory search (Inventory spec §27).
// GET /api/v1/inventory/search?q=&withStock=1 — searches item code, SKU, barcode,
// part number, name, brand, model, category, supplier part number.
import { db } from "@/lib/db";
import { handler, okList } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(
  async ({ req }) => {
    const sp = new URL(req.url).searchParams;
    const q = (sp.get("q") ?? "").trim();
    const take = Math.min(25, Math.max(1, parseInt(sp.get("take") ?? "12", 10) || 12));
    const withStockOnly = sp.get("withStock") === "1";

    const rows = q
      ? await db.inventoryItem.findMany({
          where: {
            AND: [
              { status: "ACTIVE" },
              ...(withStockOnly ? [{ stockType: "STOCKED" }] : []),
              {
                OR: [
                  { sku: { contains: q } },
                  { name: { contains: q } },
                  { nameNorm: { contains: q.toLowerCase() } },
                  { partNumber: { contains: q } },
                  { barcode: { contains: q } },
                  { brand: { contains: q } },
                  { model: { contains: q } },
                  { category: { contains: q } },
                  { supplierPartNumber: { contains: q } },
                  { description: { contains: q } },
                ],
              },
            ],
          },
          include: { supplier: { select: { id: true, name: true } } },
          orderBy: { name: "asc" },
          take,
        })
      : await db.inventoryItem.findMany({
          where: { AND: [{ status: "ACTIVE" }, ...(withStockOnly ? [{ stockType: "STOCKED" }] : [])] },
          include: { supplier: { select: { id: true, name: true } } },
          orderBy: { updatedAt: "desc" },
          take,
        });

    return okList(
      rows.map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        category: r.category,
        brand: r.brand,
        model: r.model,
        partNumber: r.partNumber,
        unit: r.unit,
        stockQty: r.stockQty,
        reservedQty: r.reservedQty,
        available: Math.round((r.stockQty - r.reservedQty) * 100) / 100,
        unitCostCents: r.unitCostCents,
        sellingPriceCents: r.sellingPriceCents,
        supplier: r.supplier,
        stockType: r.stockType,
      }))
    );
  },
  { permission: PERMISSIONS.inventory_read }
);
