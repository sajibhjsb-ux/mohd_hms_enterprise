// MOHD.HMS ENTERPRISE — Inventory item detail / update / archive (Inventory spec §23/§36/§37).
// Next 16 dynamic route: params arrive as a Promise.
// GET returns identity + STOCK (on hand/reserved/available/on order) + COST
// (last/avg/preferred supplier) + USAGE (WOs/quotations/purchases/invoices) +
// recent ledger + documents — the §23 detail page payload.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toCents } from "@/lib/hms/format";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS, normalizeUom } from "@/lib/hms/constants";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { stockSummary } from "@/lib/hms/inventory";

function withId(
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const GET = withId(PERMISSIONS.inventory_read, async (id) => {
  const item = await db.inventoryItem.findUnique({
    where: { id },
    include: {
      supplier: { select: { id: true, name: true } },
      warehouse: { select: { id: true, code: true, name: true } },
    },
  });
  if (!item) throw Errors.notFound("Inventory item not found.");

  const [movements, summary, reservations, warehouses, documents, usage] = await Promise.all([
    db.stockMovement.findMany({
      where: { itemId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { warehouse: { select: { code: true, name: true } } },
    }),
    stockSummary(db, id),
    db.stockReservation.findMany({
      where: { itemId: id, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.warehouse.findMany({ where: { status: "ACTIVE" }, orderBy: { code: "asc" } }),
    db.document.findMany({
      where: { resourceType: "INVENTORY_ITEM", resourceId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, mimeType: true, sizeBytes: true, label: true, createdAt: true, uploadedById: true },
    }),
    Promise.all([
      db.workOrderMaterial.count({ where: { inventoryItemId: id } }),
      db.quotationItem.count({ where: { itemId: id } }),
      db.purchaseItem.count({ where: { itemId: id } }),
      db.invoiceItem.count({ where: { itemId: id } }),
    ]),
  ]);

  const reorderPoint = item.reorderLevel > 0 ? item.reorderLevel : item.minStockQty;

  return ok({
    item: {
      ...item,
      low: reorderPoint > 0 ? item.stockQty <= reorderPoint : false,
      out: item.stockQty <= 0,
      reorderPoint,
    },
    stock: summary,
    warehouses,
    reservations,
    movements,
    documents,
    usage: {
      workOrders: usage[0],
      quotations: usage[1],
      purchases: usage[2],
      invoices: usage[3],
    },
  });
});

const patchSchema = z.object({
  sku: z.string().trim().min(1).max(60).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(80).optional(),
  subcategory: z.string().trim().max(80).optional(),
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  partNumber: z.string().trim().max(80).optional(),
  barcode: z.string().trim().max(80).optional(),
  itemType: z.string().trim().max(40).optional(),
  unit: z.string().trim().max(20).optional(),
  minStockQty: z.coerce.number().min(0).optional(),
  maxStockQty: z.coerce.number().min(0).optional(),
  reorderLevel: z.coerce.number().min(0).optional(),
  unitCost: z.coerce.number().min(0).optional(),
  sellingPrice: z.coerce.number().min(0).optional(),
  taxCategory: z.string().trim().max(40).optional(),
  supplierId: z.string().trim().nullable().optional(),
  supplierPartNumber: z.string().trim().max(80).optional(),
  storageLocation: z.string().trim().max(160).optional(),
  warehouseId: z.string().trim().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const PATCH = withId(PERMISSIONS.inventory_manage, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const item = await db.inventoryItem.findUnique({ where: { id } });
  if (!item) throw Errors.notFound("Inventory item not found.");

  if (body.sku && body.sku !== item.sku) {
    const dupe = await db.inventoryItem.findUnique({ where: { sku: body.sku } });
    if (dupe) throw Errors.conflict(`An item with SKU "${body.sku}" already exists.`);
  }
  if (body.supplierId) {
    const supplier = await db.supplier.findUnique({ where: { id: body.supplierId } });
    if (!supplier) throw Errors.badRequest("Supplier not found.");
  }
  if (body.warehouseId) {
    const warehouse = await db.warehouse.findUnique({ where: { id: body.warehouseId } });
    if (!warehouse) throw Errors.badRequest("Warehouse not found.");
  }

  const updated = await db.inventoryItem.update({
    where: { id },
    data: {
      ...(body.sku !== undefined ? { sku: body.sku } : {}),
      ...(body.name !== undefined ? { name: body.name, nameNorm: body.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.subcategory !== undefined ? { subcategory: body.subcategory } : {}),
      ...(body.brand !== undefined ? { brand: body.brand } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.partNumber !== undefined ? { partNumber: body.partNumber } : {}),
      ...(body.barcode !== undefined ? { barcode: body.barcode } : {}),
      ...(body.itemType !== undefined
        ? {
            itemType: body.itemType,
            stockType: ["SERVICE", "NON_STOCK"].includes(body.itemType) ? "NON_STOCK" : "STOCKED",
          }
        : {}),
      ...(body.unit !== undefined ? { unit: normalizeUom(body.unit) } : {}),
      ...(body.minStockQty !== undefined ? { minStockQty: body.minStockQty } : {}),
      ...(body.maxStockQty !== undefined ? { maxStockQty: body.maxStockQty } : {}),
      ...(body.reorderLevel !== undefined ? { reorderLevel: body.reorderLevel } : {}),
      ...(body.unitCost !== undefined ? { unitCostCents: toCents(body.unitCost) } : {}),
      ...(body.sellingPrice !== undefined ? { sellingPriceCents: toCents(body.sellingPrice) } : {}),
      ...(body.taxCategory !== undefined ? { taxCategory: body.taxCategory } : {}),
      ...(body.supplierId !== undefined ? { supplierId: body.supplierId || null } : {}),
      ...(body.supplierPartNumber !== undefined ? { supplierPartNumber: body.supplierPartNumber } : {}),
      ...(body.storageLocation !== undefined ? { storageLocation: body.storageLocation } : {}),
      ...(body.warehouseId !== undefined ? { warehouseId: body.warehouseId || null } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      updatedById: user.id,
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "ITEM_UPDATED",
    resourceType: "INVENTORY_ITEM",
    resourceId: id,
    metadata: { sku: updated.sku, changed: Object.keys(body) },
  });

  // Realtime (STEP 15): inventory views update live.
  await emit({ type: EVENT_TYPES.INVENTORY_ITEM_UPDATED, resourceType: "INVENTORY_ITEM", resourceId: id, payload: { sku: updated.sku }, actorType: "USER", actorId: user.id });
  return ok(updated);
});

export const DELETE = withId(PERMISSIONS.inventory_manage, async (id, { user }) => {
  const item = await db.inventoryItem.findUnique({ where: { id } });
  if (!item) throw Errors.notFound("Inventory item not found.");

  const [movementCount, poItemCount] = await Promise.all([
    db.stockMovement.count({ where: { itemId: id } }),
    db.purchaseItem.count({ where: { itemId: id } }),
  ]);

  if (movementCount > 0 || poItemCount > 0) {
    // Referenced by history — soft archive instead of hard delete.
    const archived = await db.inventoryItem.update({ where: { id }, data: { status: "INACTIVE", updatedById: user.id } });
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "ITEM_ARCHIVED",
      resourceType: "INVENTORY_ITEM",
      resourceId: id,
      metadata: { sku: item.sku, reason: "referenced by movements or purchase items" },
    });
    return ok({ archived: true, item: archived });
  }

  const deleted = await db.inventoryItem.delete({ where: { id } });
  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "ITEM_DELETED",
    resourceType: "INVENTORY_ITEM",
    resourceId: id,
    metadata: { sku: item.sku },
  });
  return ok({ deleted: true, item: deleted });
});
