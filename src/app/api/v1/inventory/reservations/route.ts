// MOHD.HMS ENTERPRISE — Stock reservations (Inventory spec §13/§15/§45/§46).
// GET  /api/v1/inventory/reservations?itemId=&status= — reservation list.
// POST /api/v1/inventory/reservations — reserve AVAILABLE stock (on hand minus
// already-reserved). Reserved stock is never double-counted as available.
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { createReservation, stockSummary } from "@/lib/hms/inventory";

export const GET = handler(
  async ({ req }) => {
    const sp = new URL(req.url).searchParams;
    const itemId = (sp.get("itemId") ?? "").trim();
    const status = (sp.get("status") ?? "").trim();
    const rows = await db.stockReservation.findMany({
      where: {
        ...(itemId ? { itemId } : {}),
        ...(status ? { status } : { status: { not: "CANCELLED" } }),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        item: { select: { sku: true, name: true, unit: true, stockQty: true, reservedQty: true } },
      },
    });
    return okList(rows);
  },
  { permission: PERMISSIONS.inventory_read }
);

const createSchema = z.object({
  itemId: z.string().trim().min(1),
  quantity: z.coerce.number().positive("Quantity must be positive"),
  workOrderId: z.string().trim().nullable().optional(),
  quotationId: z.string().trim().nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const reservation = await db.$transaction(async (tx) =>
      createReservation(
        {
          itemId: body.itemId,
          quantity: body.quantity,
          workOrderId: body.workOrderId ?? null,
          quotationId: body.quotationId ?? null,
          note: body.note,
        },
        { actorId: user.id, tx }
      )
    );
    const summary = await stockSummary(db, body.itemId);

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "STOCK_RESERVED",
      resourceType: "INVENTORY_ITEM",
      resourceId: body.itemId,
      metadata: { reservationId: reservation.id, quantity: body.quantity, workOrderId: body.workOrderId ?? null, quotationId: body.quotationId ?? null },
    });

    return ok({ reservation, stock: summary }, 201);
  },
  { permission: PERMISSIONS.inventory_issue }
);

export const _unusedErrors = Errors;
