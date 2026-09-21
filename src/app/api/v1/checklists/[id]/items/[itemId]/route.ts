// MOHD.HMS ENTERPRISE — Draft checklist item edit/remove (spec §25 review page).
// PATCH  /api/v1/checklists/[id]/items/[itemId] — edit a draft task (label/flags)
// DELETE — remove a task from a DRAFT (version history preserves the previous state)
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, CHECKLIST_RESPONSE_TYPES, CHECKLIST_TASK_PRIORITIES } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { parseChecklistItems } from "@/lib/hms/checklist/types";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, itemId: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string; itemId: string }> }) => {
    const { id, itemId } = await ctx.params;
    return handler((c) => fn(id, itemId, c), opts)(req);
  };
}

async function loadDraft(id: string) {
  const instance = await db.checklistInstance.findUnique({ where: { id } });
  if (!instance) throw Errors.notFound("Checklist not found.");
  if (!["DRAFT", "PENDING_APPROVAL"].includes(instance.status)) {
    throw Errors.invalidTransition("Only drafts awaiting review can be edited — approved versions are immutable.");
  }
  return instance;
}

const patchSchema = z.object({
  label: z.string().min(2).max(300).optional(),
  required: z.boolean().optional(),
  responseType: z.enum(CHECKLIST_RESPONSE_TYPES).optional(),
  priority: z.enum(CHECKLIST_TASK_PRIORITIES).optional(),
  safetyCritical: z.boolean().optional(),
  expectedResult: z.string().max(300).optional(),
  unit: z.string().max(12).optional(),
  requiresPhoto: z.boolean().optional(),
});

export const PATCH = withId(
  async (id, itemId, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const instance = await loadDraft(id);
    const items = parseChecklistItems(instance.itemsJson);
    const idx = items.findIndex((_, i) => `item-${i}` === itemId || items[i]?.label === itemId);
    if (idx === -1) throw Errors.notFound("Task not found in this draft.");
    const current = items[idx];
    const responseType = body.responseType ?? current.responseType;
    items[idx] = {
      ...current,
      ...(body.label !== undefined ? { label: body.label.slice(0, 300) } : {}),
      ...(body.required !== undefined ? { required: body.required } : {}),
      responseType,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.safetyCritical !== undefined ? { safetyCritical: body.safetyCritical } : {}),
      ...(body.expectedResult !== undefined ? { expectedResult: body.expectedResult.slice(0, 300) } : {}),
      ...(body.unit !== undefined ? { unit: body.unit.slice(0, 12) } : {}),
      ...(body.requiresPhoto !== undefined ? { requiresPhoto: body.requiresPhoto } : {}),
      failRequiresFinding: responseType === "PASSFAIL" || responseType === "YESNO",
      origin: "MANUAL",
    };
    await db.checklistInstance.update({ where: { id }, data: { itemsJson: JSON.stringify(items) } });
    await audit({
      actorId: user.id, actorEmail: user.email, action: "CHECKLIST_EDITED",
      resourceType: "CHECKLIST_INSTANCE", resourceId: id,
      metadata: { code: instance.code, itemIndex: idx },
    });
    await emit({
      type: EVENT_TYPES.CHECKLIST_UPDATED, resourceType: "CHECKLIST_INSTANCE", resourceId: id,
      payload: { code: instance.code, itemEdited: true }, actorType: "USER", actorId: user.id,
    });
    return ok({ edited: true });
  },
  { permission: PERMISSIONS.checklist_edit }
);

export const DELETE = withId(
  async (id, itemId, { user }) => {
    const instance = await loadDraft(id);
    const items = parseChecklistItems(instance.itemsJson);
    const idx = items.findIndex((_, i) => `item-${i}` === itemId || items[i]?.label === itemId);
    if (idx === -1) throw Errors.notFound("Task not found in this draft.");
    const [removed] = items.splice(idx, 1);
    if (items.length === 0) throw Errors.badRequest("A checklist must keep at least one task — regenerate instead.");
    await db.checklistInstance.update({ where: { id }, data: { itemsJson: JSON.stringify(items) } });
    await audit({
      actorId: user.id, actorEmail: user.email, action: "CHECKLIST_ITEM_REMOVED",
      resourceType: "CHECKLIST_INSTANCE", resourceId: id,
      metadata: { code: instance.code, label: removed.label },
    });
    await emit({
      type: EVENT_TYPES.CHECKLIST_UPDATED, resourceType: "CHECKLIST_INSTANCE", resourceId: id,
      payload: { code: instance.code, itemRemoved: true }, actorType: "USER", actorId: user.id,
    });
    return ok({ removed: true, itemCount: items.length });
  },
  { permission: PERMISSIONS.checklist_edit }
);
