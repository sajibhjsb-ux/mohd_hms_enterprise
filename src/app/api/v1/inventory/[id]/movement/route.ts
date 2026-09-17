// MOHD.HMS ENTERPRISE — Stock movement on an inventory item.
// Semantics: RECEIVE +qty, ISSUE -qty, RETURN +qty, ADJUST signed delta.
// Guards: stock never goes below zero; low-stock notifies ADMIN role.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS, ROLES } from "@/lib/hms/constants";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit, notifyRole } from "@/lib/hms/services";

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
    await notifyRole(ROLES.ADMIN, {
      title: "Low stock alert",
      message: `Low stock: ${result.updated.sku} ${result.updated.name} at ${result.updated.stockQty}`,
      type: "WARNING",
      resourceType: "INVENTORY_ITEM",
      resourceId: result.updated.id,
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
