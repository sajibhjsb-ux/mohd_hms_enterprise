// MOHD.HMS ENTERPRISE — Stock movement on an inventory item.
// Semantics: RECEIVE +qty, ISSUE -qty, RETURN +qty, ADJUST signed delta.
// Guards: stock never goes below zero; low-stock notifies ADMIN role.

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
  type: z.enum(["RECEIVE", "ISSUE", "RETURN", "ADJUST"]),
  quantity: z.coerce
    .number()
    .refine((v) => v !== 0, "Quantity cannot be zero.")
    .refine((v) => isFinite(v), "Quantity must be a finite number."),
  note: z.string().trim().max(500).optional(),
});

export const POST = withId(PERMISSIONS.inventory_manage, async (id, { req, user }) => {
  const body = await parseBody(req, movementSchema);
  dedupeSubmission({ userId: user.id, route: "POST /api/v1/inventory/[id]/movement", body: { id, ...body } });

  let signed: number;
  if (body.type === "ADJUST") {
    signed = body.quantity; // signed delta, may be negative
  } else {
    if (body.quantity <= 0) throw Errors.badRequest("Quantity must be a positive number.");
    signed = body.type === "ISSUE" ? -body.quantity : body.quantity;
  }

  const result = await db.$transaction(async (tx) => {
    const item = await tx.inventoryItem.findUnique({ where: { id } });
    if (!item) throw Errors.notFound("Inventory item not found.");

    const balanceAfter = item.stockQty + signed;
    if (balanceAfter < 0) throw Errors.badRequest("Insufficient stock.");

    const movement = await tx.stockMovement.create({
      data: {
        itemId: id,
        type: body.type,
        quantity: signed,
        balanceAfter,
        referenceType: "MANUAL",
        referenceId: "",
        note: body.note ?? "",
        createdById: user.id,
      },
    });
    const updated = await tx.inventoryItem.update({ where: { id }, data: { stockQty: balanceAfter } });
    return { movement, updated, minStockQty: item.minStockQty };
  });

  if (result.updated.stockQty <= result.minStockQty) {
    // §17 — low stock automation via the outbox (deduplicated per item per 24h
    // inside the handler; no repeated notification spam on repeated movements).
    await emit({
      type: EVENT_TYPES.LOW_STOCK, resourceType: "INVENTORY_ITEM", resourceId: result.updated.id,
      payload: { sku: result.updated.sku, stockQty: result.updated.stockQty, minStockQty: result.minStockQty, source: "MANUAL_MOVEMENT" },
      actorType: "USER", actorId: user.id,
    });
  }

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "STOCK_ADJUSTED",
    resourceType: "INVENTORY_ITEM",
    resourceId: id,
    metadata: { sku: result.updated.sku, type: body.type, quantity: signed, balanceAfter: result.updated.stockQty },
  });

  return ok({ item: result.updated, movement: result.movement }, 201);
});
