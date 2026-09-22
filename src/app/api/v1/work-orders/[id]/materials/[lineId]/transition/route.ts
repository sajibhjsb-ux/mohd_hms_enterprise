// MOHD.HMS ENTERPRISE — Work order material lifecycle (Inventory spec §11/§12/§42/§46).
// POST /api/v1/work-orders/[id]/materials/[lineId]/transition
//   { action: reserve | issue | use | return | cancel, quantity?, note? }
//
// REQUESTED → RESERVED   (stock reserved; available stock reduced — §13)
// RESERVED  → ISSUED     (stock decreased through the central engine + reservation consumed)
// REQUESTED → ISSUED     (direct issue; supervisor+ authority — §42)
// ISSUED    → USED       (usage acknowledged; no stock effect)
// ISSUED    → RETURNED   (unused qty back to stock through the engine)
// REQUESTED/RESERVED → CANCELLED (reservation released; no stock effect)
//
// Authorization (§42/§56/§71): technicians may REQUEST (via materials POST) and
// RETURN unused stock; reserve/issue/cancel require inventory_issue (supervisor+).
// The completion flow auto-issues still-REQUESTED lines (approved legacy behavior).
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { applyStockMovement, createReservation, consumeReservation, releaseReservation, stockSummary } from "@/lib/hms/inventory";
import { WO_DETAIL_INCLUDE, assertViewWorkOrder, isAssignedTechnician, recalcWorkOrderTotals } from "../../../../_lib";

type Ctx = { req: NextRequest; user: SessionUser };

function withIds(fn: (id: string, lineId: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string; lineId: string }> }) => {
    const { id, lineId } = await ctx.params;
    return handler((c) => fn(id, lineId, c), opts)(req);
  };
}

const schema = z.object({
  action: z.enum(["reserve", "issue", "use", "return", "cancel"]),
  quantity: z.coerce.number().positive().optional(),
  note: z.string().trim().max(500).optional(),
});

export const POST = withIds(
  async (id, lineId, { req, user }) => {
    const body = await parseBody(req, schema);
    const wo = await db.workOrder.findUnique({ where: { id }, select: { id: true, code: true, status: true, customerId: true, technicianId: true } });
    if (!wo) throw Errors.notFound("Work order not found.");
    await assertViewWorkOrder(user, wo);
    if (["COMPLETED", "CANCELLED"].includes(wo.status)) {
      throw Errors.invalidTransition(`Materials cannot change on a ${wo.status.toLowerCase()} work order.`);
    }

    const m = await db.workOrderMaterial.findUnique({ where: { id: lineId } });
    if (!m || m.workOrderId !== id) throw Errors.notFound("Material not found.");
    if (!m.inventoryItemId) throw Errors.badRequest("This material line is not linked to an inventory item.");

    const isTech = await isAssignedTechnician(user, wo.technicianId);
    const isIssuer = roleCan(user.role, PERMISSIONS.inventory_issue);
    const isUpdater = roleCan(user.role, PERMISSIONS.work_orders_update);

    const item = await db.inventoryItem.findUnique({ where: { id: m.inventoryItemId } });
    if (!item) throw Errors.badRequest("Inventory item no longer exists.");

    // requested = remaining planned qty not yet issued (defaults to full request)
    const outstanding = Math.max(0, m.quantity - m.issuedQty);
    const qty = body.quantity && body.quantity > 0 ? body.quantity : Math.max(0, outstanding - m.returnedQty);

    switch (body.action) {
      case "reserve": {
        if (!isIssuer) throw Errors.forbidden("Only supervisors/admins can reserve stock.");
        if (m.status !== "REQUESTED") throw Errors.invalidTransition(`Only REQUESTED materials can be reserved (current: ${m.status}).`);
        if (qty <= 0) throw Errors.badRequest("Nothing left to reserve for this line.");
        const reservation = await db.$transaction(async (tx) =>
          createReservation({ itemId: item.id, quantity: qty, workOrderId: id, note: `WO ${wo.code} — ${m.name}` }, { actorId: user.id, tx })
        );
        await db.workOrderMaterial.update({ where: { id: m.id }, data: { status: "RESERVED" } });
        await audit({ actorId: user.id, actorEmail: user.email, action: "WO_MATERIAL_RESERVED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, lineId: m.id, item: item.sku, quantity: qty } });
        return withDetail(id, { reserved: qty, reservationId: reservation.id, stock: await stockSummary(db, item.id) });
      }

      case "issue": {
        if (!isIssuer) throw Errors.forbidden("Only supervisors/admins can issue stock. Technicians can request materials instead.");
        if (!["REQUESTED", "RESERVED"].includes(m.status)) {
          throw Errors.invalidTransition(`Only REQUESTED or RESERVED materials can be issued (current: ${m.status}).`);
        }
        if (qty <= 0) throw Errors.badRequest("Nothing left to issue for this line.");
        const issuedAt = new Date();
        const result = await db.$transaction(async (tx) => {
          // Reserve-first flows consume the reservation; direct issues skip it.
          const active = await tx.stockReservation.findFirst({ where: { itemId: item.id, workOrderId: id, status: "ACTIVE" } });
          const stock = await applyStockMovement(tx, {
            itemId: item.id,
            type: "ISSUE",
            signedQuantity: -qty,
            referenceType: "WORK_ORDER",
            referenceId: id,
            note: `${wo.code} — ${m.name}${body.note ? ` (${body.note})` : ""}`,
            createdById: user.id,
          });
          if (active) await consumeReservation(item.id, Math.min(qty, active.quantity), id, tx);
          await tx.workOrderMaterial.update({
            where: { id: m.id },
            data: {
              status: "ISSUED",
              issuedQty: Math.round((m.issuedQty + qty) * 100) / 100,
              unitCostCents: m.unitCostCents || item.avgCostCents || item.unitCostCents,
            },
          });
          return { stock };
        });
        await recalcWorkOrderTotals(id);
        await audit({ actorId: user.id, actorEmail: user.email, action: "WO_MATERIAL_ISSUED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, lineId: m.id, item: item.sku, quantity: qty, balanceAfter: result.stock.balanceAfter } });
        if (result.stock.lowStock || result.stock.outOfStock) {
          const { emit } = await import("@/lib/hms/workflows/bus");
          const { EVENT_TYPES } = await import("@/lib/hms/workflows/types");
          await emit({
            type: result.stock.outOfStock ? EVENT_TYPES.OUT_OF_STOCK : EVENT_TYPES.LOW_STOCK,
            resourceType: "INVENTORY_ITEM",
            resourceId: item.id,
            payload: { sku: item.sku, source: "WORK_ORDER_ISSUE", workOrderCode: wo.code, balanceAfter: result.stock.balanceAfter },
            actorType: "USER",
            actorId: user.id,
          });
        }
        return withDetail(id, { issued: qty, stock: result.stock });
      }

      case "use": {
        // Usage acknowledgement — the technician (or any editor) records that the
        // issued quantity was actually used. No stock effect (§12 USED vs ISSUED).
        if (!(isTech || isUpdater)) throw Errors.forbidden();
        if (m.status !== "ISSUED") throw Errors.invalidTransition(`Only ISSUED materials can be marked used (current: ${m.status}).`);
        await db.workOrderMaterial.update({ where: { id: m.id }, data: { status: "USED" } });
        await audit({ actorId: user.id, actorEmail: user.email, action: "WO_MATERIAL_USED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, lineId: m.id, item: item.sku, issuedQty: m.issuedQty } });
        return withDetail(id, { used: m.issuedQty });
      }

      case "return": {
        // Unused issued stock goes back (safe direction — technician allowed, §12).
        if (!(isTech || isIssuer)) throw Errors.forbidden();
        if (!["ISSUED", "USED"].includes(m.status)) throw Errors.invalidTransition(`Only ISSUED/USED materials can return stock (current: ${m.status}).`);
        const returnQty = body.quantity && body.quantity > 0 ? body.quantity : Math.max(0, m.issuedQty - m.returnedQty);
        if (returnQty <= 0) throw Errors.badRequest("Nothing left to return for this line.");
        if (returnQty > m.issuedQty - m.returnedQty + 1e-9) throw Errors.badRequest("Return quantity exceeds issued quantity.");
        const result = await db.$transaction(async (tx) =>
          applyStockMovement(tx, {
            itemId: item.id,
            type: "RETURN",
            signedQuantity: returnQty,
            referenceType: "WORK_ORDER",
            referenceId: id,
            note: `${wo.code} — unused ${m.name}${body.note ? ` (${body.note})` : ""}`,
            createdById: user.id,
          })
        );
        const newReturned = Math.round((m.returnedQty + returnQty) * 100) / 100;
        await db.workOrderMaterial.update({
          where: { id: m.id },
          data: { status: newReturned >= m.issuedQty - 1e-9 ? "RETURNED" : "ISSUED", returnedQty: newReturned },
        });
        await recalcWorkOrderTotals(id);
        await audit({ actorId: user.id, actorEmail: user.email, action: "WO_MATERIAL_RETURNED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, lineId: m.id, item: item.sku, quantity: returnQty, balanceAfter: result.balanceAfter } });
        return withDetail(id, { returned: returnQty, stock: { balanceAfter: result.balanceAfter } });
      }

      case "cancel": {
        if (!(isTech || isUpdater)) throw Errors.forbidden();
        if (!["REQUESTED", "RESERVED"].includes(m.status)) {
          throw Errors.invalidTransition(`Only REQUESTED/RESERVED materials can be cancelled (current: ${m.status}).`);
        }
        await db.$transaction(async (tx) => {
          const active = await tx.stockReservation.findFirst({ where: { itemId: item.id, workOrderId: id, status: "ACTIVE" } });
          if (active) await releaseReservation(active.id, "CANCELLED", tx);
          await tx.workOrderMaterial.update({ where: { id: m.id }, data: { status: "CANCELLED" } });
        });
        await recalcWorkOrderTotals(id);
        await audit({ actorId: user.id, actorEmail: user.email, action: "WO_MATERIAL_CANCELLED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, lineId: m.id, item: item.sku } });
        return withDetail(id, { cancelled: true });
      }

      default:
        throw Errors.badRequest("Unknown action.");
    }
  },
  { permission: PERMISSIONS.work_orders_read }
);

async function withDetail(id: string, extra: Record<string, unknown>) {
  const updated = await db.workOrder.findUnique({ where: { id }, include: WO_DETAIL_INCLUDE });
  const totals = await recalcWorkOrderTotals(id);
  return ok({ ...updated, ...totals, ...extra }, 200);
}
