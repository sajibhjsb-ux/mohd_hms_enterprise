// MOHD.HMS ENTERPRISE — Stock counts / physical inventory (Inventory spec §31/§32).
// GET  /api/v1/inventory/stock-counts — count sheets list.
// POST /api/v1/inventory/stock-counts {warehouseId?, note?, lines:[{itemId, countedQty, note?}]}
// A count sheet snapshots SYSTEM qty at creation; variance = counted - system.
// Approval (admins, inventory_adjust) writes STOCK_COUNT adjustment movements —
// ordinary users can never silently modify stock balances.
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";

export const GET = handler(
  async () => {
    const rows = await db.stockCount.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        warehouse: { select: { code: true, name: true } },
        lines: { include: { item: { select: { sku: true, name: true, unit: true } } } },
      },
    });
    return okList(rows);
  },
  { permission: PERMISSIONS.inventory_read }
);

const lineSchema = z.object({
  itemId: z.string().trim().min(1),
  countedQty: z.coerce.number().min(0),
  note: z.string().trim().max(300).optional(),
});

const createSchema = z.object({
  warehouseId: z.string().trim().nullable().optional(),
  note: z.string().trim().max(500).optional(),
  lines: z.array(lineSchema).min(1, "At least one counted line is required").max(200),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    if (body.warehouseId) {
      const w = await db.warehouse.findUnique({ where: { id: body.warehouseId } });
      if (!w) throw Errors.badRequest("Warehouse not found.");
    }

    const itemIds = body.lines.map((l) => l.itemId);
    const items = await db.inventoryItem.findMany({ where: { id: { in: itemIds } } });
    if (items.length !== new Set(itemIds).size) throw Errors.badRequest("One or more inventory items were not found.");

    const code = await nextNumber("STC");
    const count = await db.stockCount.create({
      data: {
        code,
        warehouseId: body.warehouseId || null,
        note: body.note ?? "",
        createdById: user.id,
        lines: {
          create: body.lines.map((l) => {
            const item = items.find((i) => i.id === l.itemId)!;
            return {
              itemId: l.itemId,
              systemQty: item.stockQty,
              countedQty: l.countedQty,
              variance: Math.round((l.countedQty - item.stockQty) * 100) / 100,
              note: l.note ?? "",
            };
          }),
        },
      },
      include: { lines: { include: { item: { select: { sku: true, name: true, unit: true } } } } },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "STOCK_COUNT_CREATED",
      resourceType: "STOCK_COUNT",
      resourceId: count.id,
      metadata: { code: count.code, lines: count.lines.length },
    });

    return ok(count, 201);
  },
  { permission: PERMISSIONS.inventory_manage }
);
