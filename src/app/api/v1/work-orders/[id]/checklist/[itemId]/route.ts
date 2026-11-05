// MOHD.HMS ENTERPRISE — Single Work Order checklist item.
// PATCH: edit a permitted item or change its status (audited).
// DELETE: soft-remove an item with a reason (never hard-delete).
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import {
  resolveChecklistItemUpdate,
  canRemoveChecklistItem,
  type ChecklistExecutionItem,
} from "@/lib/hms/checklist/execution";
import { assertViewWorkOrder, isAssignedTechnician, isSupervisorPlus } from "../../../_lib";

type Ctx = { req: NextRequest; user: SessionUser };

function withIds(fn: (id: string, itemId: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string; itemId: string }> }) => {
    const { id, itemId } = await ctx.params;
    return handler((c) => fn(id, itemId, c), opts)(req);
  };
}

async function loadItem(id: string, itemId: string, user: SessionUser) {
  const item = await db.workOrderChecklistItem.findUnique({ where: { id: itemId } });
  if (!item || item.workOrderId !== id) throw Errors.notFound("Checklist item not found.");
  const wo = await db.workOrder.findUnique({ where: { id }, select: { id: true, code: true, status: true, technicianId: true, customerId: true } });
  if (!wo) throw Errors.notFound("Work order not found.");
  await assertViewWorkOrder(user, wo);

  if (["CLOSED", "CANCELLED"].includes(wo.status)) {
    throw Errors.invalidTransition(`Checklist items cannot be changed after the work order is ${wo.status.toLowerCase()}.`);
  }
  if (wo.status === "COMPLETED" && !isSupervisorPlus(user.role)) {
    throw Errors.forbidden("Only supervisors can change checklist items on a completed work order awaiting review.");
  }
  if (!["COMPLETED"].includes(wo.status)) {
    const allowed = (await isAssignedTechnician(user, wo.technicianId)) || roleCan(user.role, PERMISSIONS.work_orders_update);
    if (!allowed) throw Errors.forbidden();
  }
  return { wo, item };
}

const patchSchema = z.object({
  label: z.string().min(1).max(300).optional(),
  group: z.string().max(80).optional(),
  priority: z.string().max(40).optional(),
  expectedResult: z.string().max(1000).optional(),
  unit: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  response: z.string().max(2000).optional(),
  status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "NOT_APPLICABLE", "BLOCKED"]).optional(),
  statusReason: z.string().max(1000).optional(),
  done: z.boolean().optional(),
  required: z.boolean().optional(),
  safetyCritical: z.boolean().optional(),
  responseType: z.enum(["CHECKBOX", "PASSFAIL", "YESNO", "NUMERIC", "TEXT"]).optional(),
});

export const PATCH = withIds(
  async (id, itemId, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const { wo, item } = await loadItem(id, itemId, user);
    const isSupervisor = isSupervisorPlus(user.role);
    const now = new Date();

    const current: ChecklistExecutionItem = {
      id: item.id, label: item.label, status: item.status, statusReason: item.statusReason, done: item.done,
      doneAt: item.doneAt ?? null, completedById: item.completedById ?? null,
      required: item.required, responseType: item.responseType, response: item.response, notes: item.notes,
      requiresPhoto: !!item.requiresPhoto, failRequiresFinding: !!item.failRequiresFinding,
      safetyCritical: !!item.safetyCritical, group: item.group, priority: item.priority,
      expectedResult: item.expectedResult, unit: item.unit, removedAt: item.removedAt ?? null,
    };

    const result = resolveChecklistItemUpdate({ current, patch: body, actorId: user.id, isSupervisor, now });
    const updated = await db.workOrderChecklistItem.update({ where: { id: itemId }, data: result.data });

    const action = result.data.status !== undefined && result.data.status !== item.status ? "WO_CHECKLIST_STATUS_CHANGED" : "WO_CHECKLIST_EDITED";
    await audit({
      actorId: user.id, actorEmail: user.email, action, resourceType: "WORK_ORDER", resourceId: id,
      metadata: { code: wo.code, itemId: item.id, label: item.label, previous: result.previous, next: result.next },
    });

    if (result.data.status === "BLOCKED") {
      await notifyRole("SUPERVISOR", {
        title: "Checklist item blocked",
        message: `Item "${item.label}" on work order ${wo.code} is blocked: ${body.statusReason ?? ""}`,
        type: "WARNING", resourceType: "WORK_ORDER", resourceId: id,
      });
    }

    return ok(updated);
  },
  { permission: PERMISSIONS.work_orders_read }
);

export const DELETE = withIds(
  async (id, itemId, { req, user }) => {
    const { wo, item } = await loadItem(id, itemId, user);
    const isSupervisor = isSupervisorPlus(user.role);
    if (!canRemoveChecklistItem(item, isSupervisor)) {
      throw Errors.forbidden("Completed, required or safety-critical checklist items require supervisor authorization and a reason.");
    }
    const reason = new URL(req.url).searchParams.get("reason") ?? "";
    if (!reason.trim()) throw Errors.badRequest("A removal reason is required.");

    const updated = await db.workOrderChecklistItem.update({
      where: { id: itemId },
      data: { removedAt: new Date(), removedById: user.id, removalReason: reason.trim() },
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "WO_CHECKLIST_REMOVED", resourceType: "WORK_ORDER", resourceId: id,
      metadata: { code: wo.code, itemId: item.id, label: item.label, previousStatus: item.status, removalReason: reason.trim() },
    });

    return ok({ removed: true, item: updated });
  },
  { permission: PERMISSIONS.work_orders_read }
);
