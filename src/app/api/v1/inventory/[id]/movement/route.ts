// MOHD.HMS ENTERPRISE — Stock movement on an inventory item (Inventory spec §19/§32).
// All writes go through the central stock engine (applyStockMovement) so the
// item total, per-warehouse rows and the immutable ledger always agree.
// Semantics: RECEIVE +qty, ISSUE -qty, RETURN +qty, ADJUST/DAMAGE/LOSS signed delta.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS } from "@/lib/hms/constants";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";
import { applyStockMovement } from "@/lib/hms/inventory";

function withId(
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const movementSchema = z.object({
  type: z.enum(["RECEIVE", "ISSUE", "RETURN", "ADJUST", "DAMAGE", "LOSS"]),
  quantity: z.coerce
    .number()
    .refine((v) => v !== 0, "Quantity cannot be zero.")
    .refine((v) => isFinite(v), "Quantity must be a finite number."),
  note: z.string().trim().max(500).optional(),
  warehouseId: z.string().trim().optional(),
});

export const POST = withId(PERMISSIONS.inventory_manage, async (id, { req, user }) => {
  const body = await parseBody(req, movementSchema);
  dedupeSubmission({ userId: user.id, route: "POST /api/v1/inventory/[id]/movement", body: { id, ...body } });

  let signed: number;
  if (body.type === "ADJUST" || body.type === "DAMAGE" || body.type === "LOSS") {
    signed = body.quantity; // signed delta, may be negative
    if (body.type !== "ADJUST" && signed > 0) {
      throw Errors.badRequest(`${body.type} must be a negative quantity (stock leaving).`);
    }
  } else {
    if (body.quantity <= 0) throw Errors.badRequest("Quantity must be a positive number.");
    signed = body.type === "ISSUE" ? -body.quantity : body.quantity;
  }

  const result = await db.$transaction(async (tx) =>
    applyStockMovement(tx, {
      itemId: id,
      type: body.type,
      signedQuantity: signed,
      warehouseId: body.warehouseId || null,
      referenceType: "MANUAL",
      note: body.note ?? "",
      createdById: user.id,
    })
  );

  const item = await db.inventoryItem.findUnique({ where: { id } });
  if (!item) throw Errors.notFound("Inventory item not found.");

  // §17/§43/§44 — low stock / out-of-stock automation via the outbox (deduplicated
  // per item per 24h inside the workflow handlers; no notification spam).
  if (result.outOfStock) {
    await emit({
      type: EVENT_TYPES.OUT_OF_STOCK, resourceType: "INVENTORY_ITEM", resourceId: item.id,
      payload: { sku: item.sku, stockQty: item.stockQty, source: "MANUAL_MOVEMENT" },
      actorType: "USER", actorId: user.id,
    });
  } else if (result.lowStock) {
    await emit({
      type: EVENT_TYPES.LOW_STOCK, resourceType: "INVENTORY_ITEM", resourceId: item.id,
      payload: { sku: item.sku, stockQty: item.stockQty, minStockQty: item.minStockQty, reorderLevel: item.reorderLevel, source: "MANUAL_MOVEMENT" },
      actorType: "USER", actorId: user.id,
    });
  }

  // Realtime (STEP 15): stock received/consumed/adjusted updates inventory views live.
  await emit({
    type: EVENT_TYPES.INVENTORY_ADJUSTED, resourceType: "INVENTORY_ITEM", resourceId: item.id,
    payload: { sku: item.sku, movementType: body.type, quantity: signed, balanceAfter: result.balanceAfter },
    actorType: "USER", actorId: user.id,
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "STOCK_ADJUSTED",
    resourceType: "INVENTORY_ITEM",
    resourceId: id,
    metadata: { sku: item.sku, type: body.type, quantity: signed, balanceAfter: result.balanceAfter, note: body.note ?? "" },
  });

  const movement = await db.stockMovement.findUnique({ where: { id: result.movementId } });
  return ok({ item, movement }, 201);
});
