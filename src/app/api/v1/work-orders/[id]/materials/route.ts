// MOHD.HMS ENTERPRISE — Work order materials (Inventory spec §7/§10/§11/§12/§42).
// POST   { inventoryItemId?, name, quantity, unit?, unitCostCents? } → add as REQUESTED
//        (no stock effect — REQUESTED ≠ ISSUED; §11 "do NOT reduce stock merely
//        because the user adds an item"). Response carries availability (§46).
//        A technician adding materials = MATERIAL REQUEST → supervisors notified (§42).
// DELETE ?materialId= → remove (cancels any active reservation first).
// Stock is only moved by explicit ISSUE (materials/[materialId]/transition) or
// auto-issue at completion for still-REQUESTED lines (legacy flow preserved).
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notifyRole } from "@/lib/hms/services";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { stockSummary, releaseReservation } from "@/lib/hms/inventory";
import { WO_DETAIL_INCLUDE, assertViewWorkOrder, isAssignedTechnician, recalcWorkOrderTotals } from "../../_lib";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

async function loadEditable(id: string, user: SessionUser) {
  const wo = await db.workOrder.findUnique({ where: { id }, select: { id: true, code: true, status: true, customerId: true, technicianId: true } });
  if (!wo) throw Errors.notFound("Work order not found.");
  await assertViewWorkOrder(user, wo);
  const allowed = (await isAssignedTechnician(user, wo.technicianId)) || roleCan(user.role, PERMISSIONS.work_orders_update);
  if (!allowed) throw Errors.forbidden();
  if (["COMPLETED", "CANCELLED"].includes(wo.status)) {
    throw Errors.invalidTransition(`Materials cannot be changed on a ${wo.status.toLowerCase()} work order.`);
  }
  return wo;
}

const postSchema = z.object({
  inventoryItemId: z.string().min(1).optional(),
  name: z.string().min(1, "Material name is required.").max(200),
  quantity: z.number().positive("Quantity must be greater than zero.").max(1_000_000),
  unit: z.string().trim().max(20).optional(),
  unitCostCents: z.number().int("unitCostCents must be integer cents.").min(0).optional(),
});

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, postSchema);
    const wo = await loadEditable(id, user);

    let itemName = body.name;
    let unit = body.unit && body.unit.length > 0 ? body.unit : "pcs";
    let unitCostCents = body.unitCostCents ?? 0;
    let availability: Awaited<ReturnType<typeof stockSummary>> | null = null;
    let insufficient = false;

    if (body.inventoryItemId) {
      const item = await db.inventoryItem.findUnique({ where: { id: body.inventoryItemId } });
      if (!item) throw Errors.badRequest("Inventory item not found.");
      if (item.stockType === "NON_STOCK") {
        throw Errors.badRequest("Non-stock items cannot be requested as work order materials.");
      }
      // Canonical name/unit from the item master; cost defaults to average cost (§39).
      itemName = body.name.trim() || item.name;
      unit = body.unit && body.unit.length > 0 ? body.unit : item.unit;
      if (body.unitCostCents === undefined) unitCostCents = item.avgCostCents || item.unitCostCents;
      availability = await stockSummary(db, item.id);
      insufficient = body.quantity > availability.available + 1e-9;
      // §46 — availability is advisory for REQUEST lines; issuing later enforces stock.
    }

    await db.workOrderMaterial.create({
      data: {
        workOrderId: id,
        inventoryItemId: body.inventoryItemId ?? null,
        name: itemName,
        quantity: body.quantity,
        unit,
        unitCostCents,
        totalCents: Math.round(body.quantity * unitCostCents),
        status: "REQUESTED",
      },
    });
    const totals = await recalcWorkOrderTotals(id);

    await audit({ actorId: user.id, actorEmail: user.email, action: "WO_MATERIAL_ADDED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, name: itemName, quantity: body.quantity, inventoryItemId: body.inventoryItemId ?? null, status: "REQUESTED" } });

    // §42 — technician material request flow: supervisors are asked to reserve/issue.
    const isTech = await isAssignedTechnician(user, wo.technicianId);
    if (isTech) {
      await notifyRole("SUPERVISOR", {
        title: "Material request",
        message: `${user.name} requested ${body.quantity} ${unit} × ${itemName} on ${wo.code}.${insufficient ? " Available stock is insufficient — procurement may be required." : ""}`,
        type: insufficient ? "WARNING" : "INFO",
        resourceType: "WORK_ORDER",
        resourceId: id,
      });
    }

    const updated = await db.workOrder.findUnique({ where: { id }, include: WO_DETAIL_INCLUDE });
    return ok({ ...updated, ...totals, availability, insufficientAvailable: insufficient }, 201);
  },
  { permission: PERMISSIONS.work_orders_read }
);

export const DELETE = withId(
  async (id, { req, user }) => {
    const materialId = new URL(req.url).searchParams.get("materialId");
    if (!materialId) throw Errors.badRequest("materialId query parameter is required.");
    const wo = await loadEditable(id, user);

    const material = await db.workOrderMaterial.findUnique({ where: { id: materialId } });
    if (!material || material.workOrderId !== id) throw Errors.notFound("Material not found.");
    if (material.status === "ISSUED" || material.status === "USED") {
      throw Errors.invalidTransition("Issued materials cannot be removed — record a return instead.");
    }
    // Cancel any active reservation for this line before removing it.
    if (material.inventoryItemId) {
      const active = await db.stockReservation.findFirst({
        where: { itemId: material.inventoryItemId, workOrderId: id, status: "ACTIVE" },
      });
      if (active) await releaseReservation(active.id, "CANCELLED");
    }
    await db.workOrderMaterial.delete({ where: { id: material.id } });
    const totals = await recalcWorkOrderTotals(id);

    await audit({ actorId: user.id, actorEmail: user.email, action: "WO_MATERIAL_REMOVED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, materialId: material.id, name: material.name } });
    const updated = await db.workOrder.findUnique({ where: { id }, include: WO_DETAIL_INCLUDE });
    return ok({ ...updated, ...totals });
  },
  { permission: PERMISSIONS.work_orders_read }
);
