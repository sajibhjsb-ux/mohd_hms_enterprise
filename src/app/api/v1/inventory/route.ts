// MOHD.HMS ENTERPRISE — Inventory module API: items list/create.
// CONTRACT (used by Quotations module picker): GET /api/v1/inventory returns
// okList of { id, sku, name, category, unit, stockQty, minStockQty,
// unitCostCents, supplierId, supplier:{id,name}|null, status, low }.

import { z } from "zod";
import { toCents } from "@/lib/hms/format";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";

const SORT_FIELDS = new Set(["sku", "name", "category", "stockQty", "unitCostCents", "status", "createdAt"]);

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const category = (sp.get("category") ?? "").trim();
    const lowStock = sp.get("lowStock") === "1";

    const where = {
      ...(q.search ? { OR: [{ sku: { contains: q.search } }, { name: { contains: q.search } }] } : {}),
      ...(category ? { category } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(lowStock ? { stockQty: { lte: db.inventoryItem.fields.minStockQty } } : {}),
    };
    const orderBy = SORT_FIELDS.has(q.sort) ? { [q.sort]: q.dir } : { name: "asc" as const };

    const [rows, total, activeCount, lowCount, valueRows] = await Promise.all([
      db.inventoryItem.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } } },
        orderBy,
        skip: q.skip,
        take: q.take,
      }),
      db.inventoryItem.count({ where }),
      db.inventoryItem.count({ where: { status: "ACTIVE" } }),
      db.inventoryItem.count({ where: { status: "ACTIVE", stockQty: { lte: db.inventoryItem.fields.minStockQty } } }),
      db.inventoryItem.findMany({ where: { status: "ACTIVE" }, select: { stockQty: true, unitCostCents: true } }),
    ]);

    const items = rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      category: r.category,
      unit: r.unit,
      stockQty: r.stockQty,
      minStockQty: r.minStockQty,
      unitCostCents: r.unitCostCents,
      supplierId: r.supplierId,
      supplier: r.supplier,
      status: r.status,
      low: r.stockQty <= r.minStockQty,
    }));

    const stats = {
      total: activeCount,
      lowStock: lowCount,
      valueCents: valueRows.reduce((sum, r) => sum + Math.round(r.stockQty * r.unitCostCents), 0),
    };

    return okList(items, { ...pagedMeta(q.page, q.pageSize, total), stats });
  },
  { permission: PERMISSIONS.inventory_read }
);

const createSchema = z.object({
  sku: z.string().trim().max(60).optional(),
  name: z.string().trim().min(1, "Name is required").max(160),
  category: z.string().trim().max(80).optional(),
  unit: z.string().trim().max(20).optional(),
  stockQty: z.coerce.number().min(0).optional(),
  minStockQty: z.coerce.number().min(0).optional(),
  unitCost: z.coerce.number().min(0).optional(),
  supplierId: z.string().trim().nullable().optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    const sku = body.sku && body.sku.length > 0 ? body.sku : await nextNumber("ITM");
    const existing = await db.inventoryItem.findUnique({ where: { sku } });
    if (existing) throw Errors.conflict(`An item with SKU "${sku}" already exists.`);

    if (body.supplierId) {
      const supplier = await db.supplier.findUnique({ where: { id: body.supplierId } });
      if (!supplier) throw Errors.badRequest("Supplier not found.");
    }

    const stockQty = body.stockQty ?? 0;
    const item = await db.$transaction(async (tx) => {
      const created = await tx.inventoryItem.create({
        data: {
          sku,
          name: body.name,
          category: body.category && body.category.length > 0 ? body.category : "GENERAL",
          unit: body.unit && body.unit.length > 0 ? body.unit : "pcs",
          stockQty,
          minStockQty: body.minStockQty ?? 0,
          unitCostCents: toCents(body.unitCost ?? 0),
          supplierId: body.supplierId || null,
          status: "ACTIVE",
        },
      });
      if (stockQty > 0) {
        await tx.stockMovement.create({
          data: {
            itemId: created.id,
            type: "RECEIVE",
            quantity: stockQty,
            balanceAfter: stockQty,
            referenceType: "MANUAL",
            note: "Opening stock",
            createdById: user.id,
          },
        });
      }
      return created;
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "ITEM_CREATED",
      resourceType: "INVENTORY_ITEM",
      resourceId: item.id,
      metadata: { sku: item.sku, name: item.name, openingQty: stockQty },
    });

    return ok(item, 201);
  },
  { permission: PERMISSIONS.inventory_manage }
);
