// MOHD.HMS ENTERPRISE — Inventory module API: items list/create (Inventory spec §2/§27/§45/§48/§49).
// CONTRACT (used by Quotations/Work-Orders/Purchases pickers): GET /api/v1/inventory returns
// okList of { id, sku, name, category, unit, stockQty, reservedQty, available, minStockQty,
// reorderLevel, unitCostCents, avgCostCents, itemType, stockType, supplierId,
// supplier:{id,name}|null, warehouseId, status, low }.
// POST creates through the ONE canonical item flow (resolveOrCreateItem, §33/§60):
// normalize → duplicate search → 409 with matches (unless confirmed) → create.

import { z } from "zod";
import { NextResponse } from "next/server";
import { toCents } from "@/lib/hms/format";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { resolveOrCreateItem, applyStockMovement } from "@/lib/hms/inventory";

const SORT_FIELDS = new Set(["sku", "name", "category", "stockQty", "unitCostCents", "status", "createdAt"]);

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const category = (sp.get("category") ?? "").trim();
    const lowStock = sp.get("lowStock") === "1";
    const outOfStock = sp.get("outOfStock") === "1";
    const itemType = (sp.get("itemType") ?? "").trim();
    const warehouseId = (sp.get("warehouseId") ?? "").trim();

    const where = {
      ...(q.search
        ? {
            OR: [
              { sku: { contains: q.search } },
              { name: { contains: q.search } },
              { partNumber: { contains: q.search } },
              { barcode: { contains: q.search } },
              { brand: { contains: q.search } },
              { model: { contains: q.search } },
              { supplierPartNumber: { contains: q.search } },
            ],
          }
        : {}),
      ...(category ? { category } : {}),
      ...(itemType ? { itemType } : {}),
      ...(warehouseId ? { warehouseId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(lowStock ? { stockQty: { lte: db.inventoryItem.fields.reorderLevel } } : {}),
      ...(outOfStock ? { stockQty: { lte: 0 } } : {}),
    };
    const orderBy = SORT_FIELDS.has(q.sort) ? { [q.sort]: q.dir } : { name: "asc" as const };

    const [rows, total, activeCount, lowCount, outCount, reservedAgg, valueRows, openPoAgg] = await Promise.all([
      db.inventoryItem.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } } },
        orderBy,
        skip: q.skip,
        take: q.take,
      }),
      db.inventoryItem.count({ where }),
      db.inventoryItem.count({ where: { status: "ACTIVE" } }),
      db.inventoryItem.count({ where: { status: "ACTIVE", AND: [{ stockQty: { lte: db.inventoryItem.fields.reorderLevel } }, { reorderLevel: { gt: 0 } }] } }),
      db.inventoryItem.count({ where: { status: "ACTIVE", stockQty: { lte: 0 } } }),
      db.inventoryItem.aggregate({ _sum: { reservedQty: true } }),
      db.inventoryItem.findMany({ where: { status: "ACTIVE" }, select: { stockQty: true, avgCostCents: true } }),
      db.purchaseItem.aggregate({
        _sum: { quantity: true, receivedQty: true },
        where: { po: { status: { in: ["APPROVED", "PARTIALLY_RECEIVED"] } } },
      }),
    ]);

    const items = rows.map((r) => {
      const reorderPoint = r.reorderLevel > 0 ? r.reorderLevel : r.minStockQty;
      return {
        id: r.id,
        sku: r.sku,
        name: r.name,
        category: r.category,
        subcategory: r.subcategory,
        brand: r.brand,
        model: r.model,
        partNumber: r.partNumber,
        barcode: r.barcode,
        itemType: r.itemType,
        stockType: r.stockType,
        unit: r.unit,
        stockQty: r.stockQty,
        reservedQty: r.reservedQty,
        available: Math.round((r.stockQty - r.reservedQty) * 100) / 100,
        minStockQty: r.minStockQty,
        reorderLevel: r.reorderLevel,
        unitCostCents: r.unitCostCents,
        avgCostCents: r.avgCostCents,
        sellingPriceCents: r.sellingPriceCents,
        supplierId: r.supplierId,
        supplier: r.supplier,
        supplierPartNumber: r.supplierPartNumber,
        storageLocation: r.storageLocation,
        warehouseId: r.warehouseId,
        status: r.status,
        low: r.reorderLevel > 0 ? r.stockQty <= r.reorderLevel : r.stockQty <= r.minStockQty,
        out: r.stockQty <= 0,
        reorderPoint,
      };
    });

    // §48 — Inventory dashboard KPIs from real data.
    const stats = {
      total: activeCount,
      lowStock: lowCount,
      outOfStock: outCount,
      reservedQty: Math.round((reservedAgg._sum.reservedQty ?? 0) * 100) / 100,
      valueCents: valueRows.reduce((sum, r) => sum + Math.round(r.stockQty * r.avgCostCents), 0),
      onOrder: Math.round(Math.max(0, (openPoAgg._sum.quantity ?? 0) - (openPoAgg._sum.receivedQty ?? 0)) * 100) / 100,
    };

    return okList(items, { ...pagedMeta(q.page, q.pageSize, total), stats });
  },
  { permission: PERMISSIONS.inventory_read }
);

const createSchema = z.object({
  sku: z.string().trim().max(60).optional(),
  name: z.string().trim().min(1, "Name is required").max(160),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(80).optional(),
  subcategory: z.string().trim().max(80).optional(),
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  partNumber: z.string().trim().max(80).optional(),
  barcode: z.string().trim().max(80).optional(),
  itemType: z.string().trim().max(40).optional(),
  unit: z.string().trim().max(20).optional(),
  stockQty: z.coerce.number().min(0).optional(),
  minStockQty: z.coerce.number().min(0).optional(),
  maxStockQty: z.coerce.number().min(0).optional(),
  reorderLevel: z.coerce.number().min(0).optional(),
  unitCost: z.coerce.number().min(0).optional(),
  sellingPrice: z.coerce.number().min(0).optional(),
  taxCategory: z.string().trim().max(40).optional(),
  supplierId: z.string().trim().nullable().optional(),
  supplierPartNumber: z.string().trim().max(80).optional(),
  storageLocation: z.string().trim().max(160).optional(),
  /** §34 — caller confirmed "Create new" after seeing matches: skip the dup check. */
  confirmNew: z.boolean().optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    if (body.supplierId) {
      const supplier = await db.supplier.findUnique({ where: { id: body.supplierId } });
      if (!supplier) throw Errors.badRequest("Supplier not found.");
    }

    // Manual creation through the Inventory module is always allowed to set
    // initial stock (inventory_manage authority, §35).
    let outcome: Awaited<ReturnType<typeof resolveOrCreateItem>>;
    if (body.sku && body.sku.length > 0) {
      // Explicit SKU path (existing behavior): exact-duplicate guard, then create.
      const existing = await db.inventoryItem.findUnique({ where: { sku: body.sku } });
      if (existing) throw Errors.conflict(`An item with SKU "${body.sku}" already exists.`);
      outcome = await db.$transaction(async (tx) => {
        const created = await tx.inventoryItem.create({
          data: {
            sku: body.sku!,
            name: body.name,
            nameNorm: body.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim(),
            description: body.description ?? "",
            category: body.category && body.category.length > 0 ? body.category : "GENERAL",
            subcategory: body.subcategory ?? "",
            brand: body.brand ?? "",
            model: body.model ?? "",
            partNumber: body.partNumber ?? "",
            barcode: body.barcode ?? "",
            itemType: body.itemType ?? "STOCK",
            stockType: ["SERVICE", "NON_STOCK"].includes(body.itemType ?? "STOCK") ? "NON_STOCK" : "STOCKED",
            unit: body.unit && body.unit.length > 0 ? body.unit : "pcs",
            minStockQty: body.minStockQty ?? 0,
            maxStockQty: body.maxStockQty ?? 0,
            reorderLevel: body.reorderLevel ?? 0,
            unitCostCents: toCents(body.unitCost ?? 0),
            avgCostCents: toCents(body.unitCost ?? 0),
            sellingPriceCents: toCents(body.sellingPrice ?? 0),
            taxCategory: body.taxCategory ?? "",
            supplierId: body.supplierId || null,
            supplierPartNumber: body.supplierPartNumber ?? "",
            storageLocation: body.storageLocation ?? "",
            createdById: user.id,
            status: "ACTIVE",
          },
        });
        if ((body.stockQty ?? 0) > 0) {
          await applyStockMovement(tx, {
            itemId: created.id,
            type: "OPENING",
            signedQuantity: body.stockQty ?? 0,
            referenceType: "ITEM",
            referenceId: created.id,
            note: "Opening stock",
            createdById: user.id,
            unitCostCents: toCents(body.unitCost ?? 0),
          });
        }
        return {
          status: "CREATED" as const,
          item: { id: created.id, sku: created.sku, name: created.name, category: created.category, unit: created.unit, stockQty: created.stockQty },
        };
      });
    } else {
      outcome = await db.$transaction(async (tx) =>
        resolveOrCreateItem(
          {
            name: body.name,
            description: body.description,
            category: body.category,
            subcategory: body.subcategory,
            brand: body.brand,
            model: body.model,
            partNumber: body.partNumber,
            barcode: body.barcode,
            itemType: body.itemType,
            unit: body.unit,
            minStockQty: body.minStockQty,
            maxStockQty: body.maxStockQty,
            reorderLevel: body.reorderLevel,
            unitCostCents: toCents(body.unitCost ?? 0),
            sellingPriceCents: toCents(body.sellingPrice ?? 0),
            supplierId: body.supplierId ?? null,
            supplierPartNumber: body.supplierPartNumber,
            storageLocation: body.storageLocation,
            initialStockQty: body.stockQty ?? 0,
            forceNew: body.confirmNew === true,
          },
          { actorId: user.id, allowInitialStock: true, tx }
        ),
        { timeout: 20000, maxWait: 10000 }
      );
    }

    if (outcome.status === "MATCHES") {
      // §34 — surface duplicates; the UI shows [Use Existing] / [Create New].
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "ITEM_MATCHES",
            message: "Similar inventory items already exist. Use an existing item or confirm creating a new one.",
            matches: outcome.matches,
          },
        },
        { status: 409 }
      );
    }

    if (outcome.status === "CREATED") {
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "ITEM_CREATED",
        resourceType: "INVENTORY_ITEM",
        resourceId: outcome.item.id,
        metadata: { sku: outcome.item.sku, name: outcome.item.name, openingQty: body.stockQty ?? 0 },
      });
      await emit({
        type: EVENT_TYPES.INVENTORY_ITEM_CREATED,
        resourceType: "INVENTORY_ITEM",
        resourceId: outcome.item.id,
        payload: { sku: outcome.item.sku, name: outcome.item.name, source: "INVENTORY_MODULE" },
        actorType: "USER",
        actorId: user.id,
      });
    } else {
      // Reused an existing canonical item (concurrent creation or exact match).
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "ITEM_REUSED_EXISTING",
        resourceType: "INVENTORY_ITEM",
        resourceId: outcome.item.id,
        metadata: { sku: outcome.item.sku, matchedBy: outcome.matchedBy },
      });
      return ok({ ...outcome, duplicate: true }, 200);
    }

    const full = await db.inventoryItem.findUnique({ where: { id: outcome.item.id } });
    return ok(full, 201);
  },
  { permission: PERMISSIONS.inventory_manage }
);
