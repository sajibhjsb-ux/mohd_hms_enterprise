// MOHD.HMS ENTERPRISE — Purchase order workflow transitions (Inventory spec §17/§18).
// submit (DRAFT→PENDING_APPROVAL) · approve/reject (purchases_approve) ·
// receive (goods receipt: full/partial, rejected/damaged quantities — only the
// ACCEPTED quantity increases stock, through the central engine) · cancel.
// All transitions are validated server-side; the client cannot skip states.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS, ROLES } from "@/lib/hms/constants";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit, notifyRole } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
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

const transitionSchema = z.object({
  action: z.enum(["submit", "approve", "reject", "receive", "cancel"]),
  items: z
    .array(
      z.object({
        purchaseItemId: z.string().trim().min(1),
        /** Accepted quantity — the amount that actually entered stock. */
        quantity: z.coerce.number().positive("Receive quantity must be greater than zero."),
        /** §18 — quality outcome quantities (must not exceed the accepted qty context). */
        rejectedQty: z.coerce.number().min(0).optional(),
        damagedQty: z.coerce.number().min(0).optional(),
        note: z.string().trim().max(300).optional(),
      })
    )
    .optional(),
});

const includeDetail = {
  supplier: { select: { id: true, name: true, code: true } },
  items: { include: { item: { select: { id: true, sku: true, name: true, unit: true } } } },
} as const;

export const POST = withId(PERMISSIONS.purchases_manage, async (id, { req, user }) => {
  const body = await parseBody(req, transitionSchema);

  // approve/reject require the dedicated approval permission.
  if ((body.action === "approve" || body.action === "reject") && !roleCan(user.role, PERMISSIONS.purchases_approve)) {
    throw Errors.forbidden("You do not have permission to approve purchase orders.");
  }

  const po = await db.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
  if (!po) throw Errors.notFound("Purchase order not found.");

  switch (body.action) {
    case "submit": {
      if (po.status !== "DRAFT") throw Errors.invalidTransition("Only draft purchase orders can be submitted.");
      const updated = await db.purchaseOrder.update({
        where: { id },
        data: { status: "PENDING_APPROVAL" },
        include: includeDetail,
      });
      const payload = {
        title: "Purchase approval needed",
        message: `PO ${po.code} awaiting approval`,
        type: "INFO" as const,
        resourceType: "PURCHASE_ORDER",
        resourceId: po.id,
      };
      await notifyRole(ROLES.FINANCE, payload);
      await notifyRole(ROLES.ADMIN, payload);
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PO_SUBMITTED",
        resourceType: "PURCHASE_ORDER",
        resourceId: po.id,
        metadata: { code: po.code, totalCents: po.totalCents },
      });
      return ok(updated);
    }

    case "approve": {
      if (po.status !== "PENDING_APPROVAL") throw Errors.invalidTransition("Only purchase orders pending approval can be approved.");
      const updated = await db.purchaseOrder.update({
        where: { id },
        data: { status: "APPROVED", approvedById: user.id, approvedAt: new Date() },
        include: includeDetail,
      });
      await notifyRole(ROLES.SUPERVISOR, {
        title: "Purchase order approved",
        message: `PO ${po.code} approved — ready for receiving.`,
        type: "SUCCESS",
        resourceType: "PURCHASE_ORDER",
        resourceId: po.id,
      });
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PO_APPROVED",
        resourceType: "PURCHASE_ORDER",
        resourceId: po.id,
        metadata: { code: po.code, totalCents: po.totalCents },
      });
      return ok(updated);
    }

    case "reject": {
      if (po.status !== "PENDING_APPROVAL") throw Errors.invalidTransition("Only purchase orders pending approval can be rejected.");
      const updated = await db.purchaseOrder.update({
        where: { id },
        data: { status: "REJECTED" },
        include: includeDetail,
      });
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PO_REJECTED",
        resourceType: "PURCHASE_ORDER",
        resourceId: po.id,
        metadata: { code: po.code },
      });
      return ok(updated);
    }

    case "receive": {
      if (po.status !== "APPROVED" && po.status !== "PARTIALLY_RECEIVED") {
        throw Errors.invalidTransition("Only approved purchase orders can receive stock.");
      }

      const updated = await db.$transaction(async (tx) => {
        const poItems = await tx.purchaseItem.findMany({ where: { poId: id } });

        const lines =
          body.items && body.items.length > 0
            ? body.items
            : poItems
                .filter((pi) => pi.receivedQty < pi.quantity)
                .map((pi) => ({ purchaseItemId: pi.id, quantity: pi.quantity - pi.receivedQty, rejectedQty: 0, damagedQty: 0, note: undefined as string | undefined }));

        if (lines.length === 0) throw Errors.badRequest("Nothing left to receive on this order.");

        for (const line of lines) {
          const pi = poItems.find((p) => p.id === line.purchaseItemId);
          if (!pi) throw Errors.badRequest("A receive line does not belong to this purchase order.");
          const remaining = pi.quantity - pi.receivedQty;
          const rejected = line.rejectedQty ?? 0;
          const damaged = line.damagedQty ?? 0;
          if (line.quantity > remaining + 1e-9) {
            throw Errors.badRequest(`Receive quantity for "${pi.description}" exceeds the remaining ${remaining}.`);
          }
          if (rejected + damaged > line.quantity + 1e-9) {
            throw Errors.badRequest(`Rejected + damaged quantity for "${pi.description}" cannot exceed the received quantity.`);
          }

          await tx.purchaseItem.update({
            where: { id: pi.id },
            data: {
              receivedQty: pi.receivedQty + line.quantity,
              rejectedQty: pi.rejectedQty + rejected,
              damagedQty: pi.damagedQty + damaged,
            },
          });

          // §18 — ONLY the accepted quantity increases stock, through the central
          // engine (also maintains moving-average cost + last purchase cost, §25).
          if (pi.itemId && line.quantity - rejected - damaged > 1e-9) {
            const accepted = line.quantity - rejected - damaged;
            const invItem = await tx.inventoryItem.findUnique({ where: { id: pi.itemId } });
            if (invItem && invItem.stockType !== "NON_STOCK") {
              await applyStockMovement(tx, {
                itemId: invItem.id,
                type: "RECEIVE",
                signedQuantity: accepted,
                referenceType: "PURCHASE",
                referenceId: po.id,
                note: `Received against ${po.code}${rejected || damaged ? ` (rejected ${rejected}, damaged ${damaged})` : ""}${line.note ? ` — ${line.note}` : ""}`,
                createdById: user.id,
                unitCostCents: pi.unitCostCents,
              });
            }
          }
        }

        const refreshed = await tx.purchaseItem.findMany({ where: { poId: id } });
        const allReceived = refreshed.every((pi) => pi.receivedQty >= pi.quantity - 1e-9);

        return tx.purchaseOrder.update({
          where: { id },
          data: {
            status: allReceived ? "RECEIVED" : "PARTIALLY_RECEIVED",
            receivedAt: allReceived ? new Date() : null,
          },
          include: includeDetail,
        });
      });

      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PO_RECEIVED",
        resourceType: "PURCHASE_ORDER",
        resourceId: po.id,
        metadata: { code: po.code, status: updated.status, lines: body.items?.length ?? "all-remaining" },
      });
      // Outbox (§19): receipt notification workflow keys off this event.
      await emit({
        type: EVENT_TYPES.PURCHASE_RECEIVED, resourceType: "PURCHASE_ORDER", resourceId: po.id,
        payload: { code: po.code, status: updated.status }, actorType: "USER", actorId: user.id,
      });
      return ok(updated);
    }

    case "cancel": {
      if (!["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(po.status)) {
        throw Errors.invalidTransition("This purchase order can no longer be cancelled.");
      }
      const updated = await db.purchaseOrder.update({
        where: { id },
        data: { status: "CANCELLED" },
        include: includeDetail,
      });
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PO_CANCELLED",
        resourceType: "PURCHASE_ORDER",
        resourceId: po.id,
        metadata: { code: po.code, fromStatus: po.status },
      });
      return ok(updated);
    }
  }
});
