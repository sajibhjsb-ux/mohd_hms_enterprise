// MOHD.HMS ENTERPRISE — Work order materials.
// POST   { inventoryItemId?, name, quantity, unitCostCents } → add + recompute totals
// DELETE ?materialId=                                        → remove + recompute totals
// Stock is deducted once, at completion (see transition route).
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
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
  unitCostCents: z.number().int("unitCostCents must be integer cents.").min(0),
});

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, postSchema);
    const wo = await loadEditable(id, user);

    if (body.inventoryItemId) {
      const item = await db.inventoryItem.findUnique({ where: { id: body.inventoryItemId }, select: { id: true } });
      if (!item) throw Errors.badRequest("Inventory item not found.");
    }

    await db.workOrderMaterial.create({
      data: {
        workOrderId: id,
        inventoryItemId: body.inventoryItemId ?? null,
        name: body.name,
        quantity: body.quantity,
        unitCostCents: body.unitCostCents,
        totalCents: Math.round(body.quantity * body.unitCostCents),
      },
    });
    const totals = await recalcWorkOrderTotals(id);

    await audit({ actorId: user.id, actorEmail: user.email, action: "WO_MATERIAL_ADDED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, name: body.name, quantity: body.quantity } });
    const updated = await db.workOrder.findUnique({ where: { id }, include: WO_DETAIL_INCLUDE });
    return ok({ ...updated, ...totals }, 201);
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
    await db.workOrderMaterial.delete({ where: { id: material.id } });
    const totals = await recalcWorkOrderTotals(id);

    await audit({ actorId: user.id, actorEmail: user.email, action: "WO_MATERIAL_REMOVED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, materialId: material.id, name: material.name } });
    const updated = await db.workOrder.findUnique({ where: { id }, include: WO_DETAIL_INCLUDE });
    return ok({ ...updated, ...totals });
  },
  { permission: PERMISSIONS.work_orders_read }
);
