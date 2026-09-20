// MOHD.HMS ENTERPRISE — Work order checklist.
// POST  { label }          → append an item (while not COMPLETED/CANCELLED)
// PATCH { itemId, done }   → toggle an item (assigned technician or work_orders_update; not after COMPLETED)
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { assertViewWorkOrder, isAssignedTechnician } from "../../_lib";

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
  return wo;
}

const postSchema = z.object({
  label: z.string().min(1, "Checklist item label is required.").max(300),
  required: z.boolean().optional(),
  responseType: z.enum(["CHECKBOX", "PASSFAIL", "YESNO", "NUMERIC", "TEXT"]).optional(),
});

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, postSchema);
    const wo = await loadEditable(id, user);
    if (["COMPLETED", "CANCELLED"].includes(wo.status)) {
      throw Errors.invalidTransition(`Checklist items cannot be added to a ${wo.status.toLowerCase()} work order.`);
    }
    const count = await db.workOrderChecklistItem.count({ where: { workOrderId: id } });
    const item = await db.workOrderChecklistItem.create({
      data: {
        workOrderId: id,
        label: body.label,
        required: body.required ?? false,
        responseType: body.responseType ?? "CHECKBOX",
        sortOrder: count,
      },
    });
    await audit({ actorId: user.id, actorEmail: user.email, action: "WO_CHECKLIST_ADDED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, label: body.label } });
    return ok(item, 201);
  },
  { permission: PERMISSIONS.work_orders_read }
);

// PM §17 — rich checklist recording: done flag + typed response + technician notes.
const patchSchema = z.object({
  itemId: z.string().min(1, "itemId is required."),
  done: z.boolean().optional(),
  response: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
});

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const wo = await loadEditable(id, user);
    if (wo.status === "COMPLETED") {
      throw Errors.invalidTransition("Checklist cannot be changed after the work order is completed.");
    }
    const item = await db.workOrderChecklistItem.findUnique({ where: { id: body.itemId } });
    if (!item || item.workOrderId !== id) throw Errors.notFound("Checklist item not found.");
    const done = body.done ?? item.done;
    // A non-checkbox item with a recorded response is automatically complete.
    const response = body.response ?? item.response;
    const effectiveDone = item.responseType === "CHECKBOX" ? done : response.trim() !== "" ? true : done;
    const updated = await db.workOrderChecklistItem.update({
      where: { id: item.id },
      data: {
        done: effectiveDone,
        doneAt: effectiveDone ? (item.doneAt ?? new Date()) : null,
        ...(body.response !== undefined ? { response } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
    });
    await audit({ actorId: user.id, actorEmail: user.email, action: "WO_CHECKLIST_TOGGLED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code: wo.code, itemId: item.id, done: effectiveDone } });
    return ok(updated);
  },
  { permission: PERMISSIONS.work_orders_read }
);
