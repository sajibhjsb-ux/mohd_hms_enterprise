// MOHD.HMS ENTERPRISE — Release a stock reservation (Inventory spec §13/§55).
// POST /api/v1/inventory/reservations/[id]/release {reason?, status?} — returns
// the reserved quantity to available stock (status RELEASED, or CANCELLED).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS } from "@/lib/hms/constants";
import { parseBody } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { releaseReservation, stockSummary } from "@/lib/hms/inventory";

function withId(
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const schema = z.object({
  status: z.enum(["RELEASED", "CANCELLED"]).optional(),
  reason: z.string().trim().max(500).optional(),
});

export const POST = withId(PERMISSIONS.inventory_issue, async (id, { req, user }) => {
  let body: z.infer<typeof schema> = { status: "RELEASED", reason: "" };
  try {
    body = await parseBody(req, schema);
  } catch {
    // body optional
  }
  const reservation = await releaseReservation(id, body.status ?? "RELEASED");
  const summary = await stockSummary(db, reservation.itemId);
  const item = await db.inventoryItem.findUnique({ where: { id: reservation.itemId }, select: { sku: true } });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "STOCK_RESERVATION_RELEASED",
    resourceType: "INVENTORY_ITEM",
    resourceId: reservation.itemId,
    metadata: { reservationId: reservation.id, quantity: reservation.quantity, status: body.status ?? "RELEASED", reason: body.reason ?? "" },
  });
  await emit({
    type: EVENT_TYPES.INVENTORY_ADJUSTED,
    resourceType: "INVENTORY_ITEM",
    resourceId: reservation.itemId,
    payload: { sku: item?.sku, event: "RESERVATION_RELEASED", quantity: reservation.quantity },
    actorType: "USER",
    actorId: user.id,
  });

  return ok({ reservation, stock: summary });
});

export const _runtime = Errors;
