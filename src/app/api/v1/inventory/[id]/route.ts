// MOHD.HMS ENTERPRISE — Inventory item detail / update / archive.
// Next 16 dynamic route: params arrive as a Promise.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toCents } from "@/lib/hms/format";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS } from "@/lib/hms/constants";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

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
    include: { supplier: { select: { id: true, name: true } } },
  });
  if (!item) throw Errors.notFound("Inventory item not found.");

  const movements = await db.stockMovement.findMany({
    where: { itemId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return ok({
    item: { ...item, low: item.stockQty <= item.minStockQty },
    movements,
  });
});

const patchSchema = z.object({
  sku: z.string().trim().min(1).max(60).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  category: z.string().trim().max(80).optional(),
  unit: z.string().trim().max(20).optional(),
  minStockQty: z.coerce.number().min(0).optional(),
  unitCost: z.coerce.number().min(0).optional(),
  supplierId: z.string().trim().nullable().optional(),
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

  const updated = await db.inventoryItem.update({
    where: { id },
    data: {
      ...(body.sku !== undefined ? { sku: body.sku } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.unit !== undefined ? { unit: body.unit } : {}),
      ...(body.minStockQty !== undefined ? { minStockQty: body.minStockQty } : {}),
      ...(body.unitCost !== undefined ? { unitCostCents: toCents(body.unitCost) } : {}),
      ...(body.supplierId !== undefined ? { supplierId: body.supplierId || null } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "ITEM_UPDATED",
    resourceType: "INVENTORY_ITEM",
    resourceId: id,
    metadata: { sku: updated.sku },
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
    const archived = await db.inventoryItem.update({ where: { id }, data: { status: "INACTIVE" } });
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
