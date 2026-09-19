// MOHD.HMS ENTERPRISE — Work order detail (GET) + edit (PATCH).
// PATCH: core fields need work_orders_update; technician assignment needs
// work_orders_assign; labour hours/rate editable by assigned technician or
// work_orders_update while IN_PROGRESS (totals recomputed).
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { PERMISSIONS, PRIORITIES } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { WO_DETAIL_INCLUDE, assertViewWorkOrder, isAssignedTechnician, isSupervisorPlus } from "../_lib";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

export const GET = withId(
  async (id, { user }) => {
    const wo = await db.workOrder.findUnique({ where: { id }, include: WO_DETAIL_INCLUDE });
    if (!wo) throw Errors.notFound("Work order not found.");
    await assertViewWorkOrder(user, wo);
    return ok(wo);
  },
  { permission: PERMISSIONS.work_orders_read }
);

const patchSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().max(5000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  scheduledDate: z.string().max(40).nullable().optional(),
  notes: z.string().max(5000).optional(),
  technicianId: z.string().min(1).nullable().optional(),
  labourHours: z.number().min(0).max(10_000).optional(),
  labourRateCents: z.number().int().min(0).max(100_000_000).optional(),
});

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const wo = await db.workOrder.findUnique({ where: { id }, include: WO_DETAIL_INCLUDE });
    if (!wo) throw Errors.notFound("Work order not found.");
    await assertViewWorkOrder(user, wo);

    const hasCore = body.title !== undefined || body.description !== undefined || body.priority !== undefined
      || body.scheduledDate !== undefined || body.notes !== undefined;
    const hasAssign = body.technicianId !== undefined;
    const hasLabour = body.labourHours !== undefined || body.labourRateCents !== undefined;
    if (!hasCore && !hasAssign && !hasLabour) throw Errors.badRequest("Nothing to update.");

    if (hasCore && !roleCan(user.role, PERMISSIONS.work_orders_update)) {
      throw Errors.forbidden("You do not have permission to edit work order details.");
    }

    if (hasAssign) {
      if (!roleCan(user.role, PERMISSIONS.work_orders_assign)) {
        throw Errors.forbidden("You do not have permission to assign technicians.");
      }
      if (!["PENDING", "ACCEPTED", "ON_HOLD"].includes(wo.status)) {
        throw Errors.invalidTransition(`Technician cannot be changed while status is ${wo.status}.`);
      }
    }

    if (hasLabour) {
      const allowed = wo.status === "IN_PROGRESS"
        && ((await isAssignedTechnician(user, wo.technicianId)) || roleCan(user.role, PERMISSIONS.work_orders_update) || isSupervisorPlus(user.role));
      if (!allowed) {
        throw Errors.forbidden("Labour hours/rate can only be edited by the assigned technician while the work order is IN_PROGRESS.");
      }
    }

    let scheduledDate: Date | null | undefined;
    if (body.scheduledDate !== undefined) {
      if (body.scheduledDate === null || body.scheduledDate === "") scheduledDate = null;
      else {
        const d = new Date(body.scheduledDate);
        if (isNaN(d.getTime())) throw Errors.badRequest("scheduledDate is not a valid date.");
        scheduledDate = d;
      }
    }

    let labourTotalCents: number | undefined;
    if (hasLabour) {
      const hours = body.labourHours ?? wo.labourHours;
      const rate = body.labourRateCents ?? wo.labourRateCents;
      labourTotalCents = Math.round(hours * rate);
    }

    const updated = await db.workOrder.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(scheduledDate !== undefined ? { scheduledDate } : {}),
        ...(hasAssign ? { technicianId: body.technicianId ?? null } : {}),
        ...(body.labourHours !== undefined ? { labourHours: body.labourHours } : {}),
        ...(body.labourRateCents !== undefined ? { labourRateCents: body.labourRateCents } : {}),
        ...(labourTotalCents !== undefined ? { labourTotalCents, totalCents: labourTotalCents + wo.materialsTotalCents } : {}),
      },
      include: WO_DETAIL_INCLUDE,
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_UPDATED",
      resourceType: "WORK_ORDER", resourceId: id,
      metadata: { code: wo.code, fields: Object.keys(body) },
    });

    if (hasAssign && updated.technician?.user?.id && updated.technician.user.id !== user.id) {
      await notify({
        userId: updated.technician.user.id, title: "Work order assigned",
        message: `Work order ${wo.code} has been assigned to you: ${wo.title}`,
        type: "INFO", resourceType: "WORK_ORDER", resourceId: id,
      });
    }

    // Realtime (STEP 13/39-40): assignment/detail changes propagate live.
    await emit({ type: EVENT_TYPES.WORK_ORDER_UPDATED, resourceType: "WORK_ORDER", resourceId: id, payload: { code: wo.code, fields: Object.keys(body) }, actorType: "USER", actorId: user.id });
    return ok(updated);
  },
  { permission: PERMISSIONS.work_orders_read }
);
