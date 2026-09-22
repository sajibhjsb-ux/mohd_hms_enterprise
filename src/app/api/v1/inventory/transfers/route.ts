// MOHD.HMS ENTERPRISE — Stock transfers between warehouses (Inventory spec §21/§22).
// GET  /api/v1/inventory/transfers — transfer leg history (TRANSFER_OUT/TRANSFER_IN pairs).
// POST /api/v1/inventory/transfers {itemId, fromWarehouseId, toWarehouseId, quantity, note?}
// Flow: TRANSFER_REQUEST → OUT → IN → COMPLETE (atomic pair; both ledgers written §22).
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

export const GET = handler(
  async ({ req }) => {
    const sp = new URL(req.url).searchParams;
    const itemId = (sp.get("itemId") ?? "").trim();
    const rows = await db.stockMovement.findMany({
      where: { type: { in: ["TRANSFER_OUT", "TRANSFER_IN"] }, ...(itemId ? { itemId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        item: { select: { sku: true, name: true, unit: true } },
        warehouse: { select: { code: true, name: true } },
      },
    });
    return okList(rows);
  },
  { permission: PERMISSIONS.inventory_read }
);

const transferSchema = z.object({
  itemId: z.string().trim().min(1),
  fromWarehouseId: z.string().trim().min(1),
  toWarehouseId: z.string().trim().min(1),
  quantity: z.coerce.number().positive("Transfer quantity must be positive"),
  note: z.string().trim().max(500).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, transferSchema);
    if (body.fromWarehouseId === body.toWarehouseId) {
      throw Errors.badRequest("Source and destination warehouses must be different.");
    }
    const [fromW, toW] = await Promise.all([
      db.warehouse.findUnique({ where: { id: body.fromWarehouseId } }),
      db.warehouse.findUnique({ where: { id: body.toWarehouseId } }),
    ]);
    if (!fromW || fromW.status !== "ACTIVE") throw Errors.badRequest("Source warehouse not found or inactive.");
    if (!toW || toW.status !== "ACTIVE") throw Errors.badRequest("Destination warehouse not found or inactive.");

    const ref = `TRF-${Date.now().toString(36).toUpperCase()}`;
    const result = await db.$transaction(async (tx) => {
      // Company-wide total (item.stockQty) is unchanged by a transfer — both legs
      // move only the per-warehouse WarehouseStock rows; each leg writes its own
      // immutable ledger row with the warehouse-level balance (§22).
      const item = await tx.inventoryItem.findUnique({ where: { id: body.itemId } });
      if (!item) throw Errors.notFound("Inventory item not found.");
      if (item.stockType === "NON_STOCK") throw Errors.badRequest("Non-stock items cannot be transferred.");

      const src = await tx.warehouseStock.findUnique({
        where: { itemId_warehouseId: { itemId: body.itemId, warehouseId: body.fromWarehouseId } },
      });
      const srcQty = src?.qty ?? 0;
      if (srcQty < body.quantity - 1e-9) {
        throw Errors.badRequest(`Insufficient stock at ${fromW.code}: on hand ${srcQty} ${item.unit}, requested ${body.quantity} ${item.unit}.`);
      }
      const srcAfter = Math.round((srcQty - body.quantity) * 100) / 100;
      if (src) {
        await tx.warehouseStock.update({ where: { id: src.id }, data: { qty: srcAfter } });
      } else {
        await tx.warehouseStock.create({ data: { itemId: body.itemId, warehouseId: body.fromWarehouseId, qty: srcAfter } });
      }
      const outMovement = await tx.stockMovement.create({
        data: {
          itemId: body.itemId,
          type: "TRANSFER_OUT",
          quantity: -body.quantity,
          balanceAfter: srcAfter,
          referenceType: "TRANSFER",
          referenceId: ref,
          note: `Transfer to ${toW.code}${body.note ? ` — ${body.note}` : ""}`,
          warehouseId: body.fromWarehouseId,
          createdById: user.id,
        },
      });

      const dest = await tx.warehouseStock.findUnique({
        where: { itemId_warehouseId: { itemId: body.itemId, warehouseId: body.toWarehouseId } },
      });
      const destQty = Math.round(((dest?.qty ?? 0) + body.quantity) * 100) / 100;
      await tx.warehouseStock.upsert({
        where: { itemId_warehouseId: { itemId: body.itemId, warehouseId: body.toWarehouseId } },
        create: { itemId: body.itemId, warehouseId: body.toWarehouseId, qty: destQty },
        update: { qty: destQty },
      });
      const inMovement = await tx.stockMovement.create({
        data: {
          itemId: body.itemId,
          type: "TRANSFER_IN",
          quantity: body.quantity,
          balanceAfter: destQty,
          referenceType: "TRANSFER",
          referenceId: ref,
          note: `Transfer from ${fromW.code}${body.note ? ` — ${body.note}` : ""}`,
          warehouseId: body.toWarehouseId,
          createdById: user.id,
        },
      });
      return { outId: outMovement.id, inId: inMovement.id, ref };
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "STOCK_TRANSFERRED",
      resourceType: "INVENTORY_ITEM",
      resourceId: body.itemId,
      metadata: { reference: result.ref, quantity: body.quantity, from: fromW.code, to: toW.code, note: body.note ?? "" },
    });
    await emit({
      type: EVENT_TYPES.INVENTORY_ADJUSTED,
      resourceType: "INVENTORY_ITEM",
      resourceId: body.itemId,
      payload: { reference: result.ref, transfer: true, quantity: body.quantity, from: fromW.code, to: toW.code },
      actorType: "USER",
      actorId: user.id,
    });

    return ok({ reference: result.ref, outMovementId: result.outId, inMovementId: result.inId }, 201);
  },
  { permission: PERMISSIONS.inventory_manage }
);
