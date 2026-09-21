// MOHD.HMS ENTERPRISE — Draft checklist item management (spec §25 review page).
// POST /api/v1/checklists/[id]/items — add a task to a DRAFT (human edit, audited).
// Only drafts awaiting review can be edited — approved/active versions are
// immutable (§25 "Do not allow approved historical versions to be modified silently").
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { validateManualItem } from "@/lib/hms/checklist/validate";
import { parseChecklistItems } from "@/lib/hms/checklist/types";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

const bodySchema = z.record(z.string(), z.unknown());

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, bodySchema);
    const item = validateManualItem(body);
    if (!item) throw Errors.badRequest("Task label is required (min 2 characters).");
    const instance = await db.checklistInstance.findUnique({ where: { id } });
    if (!instance) throw Errors.notFound("Checklist not found.");
    if (!["DRAFT", "PENDING_APPROVAL"].includes(instance.status)) {
      throw Errors.invalidTransition("Only drafts awaiting review can be edited.");
    }
    const items = parseChecklistItems(instance.itemsJson);
    if (items.length >= 80) throw Errors.badRequest("Checklist reached the maximum of 80 tasks.");
    items.push(item);
    const updated = await db.checklistInstance.update({
      where: { id },
      data: {
        itemsJson: JSON.stringify(items),
        origin: items.some((it) => it.origin === "AI" || it.origin === "TEMPLATE") ? (instance.origin === "MANUAL" ? "HYBRID" : instance.origin) : "MANUAL",
      },
    });
    await audit({
      actorId: user.id, actorEmail: user.email, action: "CHECKLIST_ITEM_ADDED",
      resourceType: "CHECKLIST_INSTANCE", resourceId: id,
      metadata: { code: instance.code, label: item.label },
    });
    await emit({
      type: EVENT_TYPES.CHECKLIST_UPDATED, resourceType: "CHECKLIST_INSTANCE", resourceId: id,
      payload: { code: instance.code, itemAdded: true }, actorType: "USER", actorId: user.id,
    });
    return ok({ itemCount: parseChecklistItems(updated.itemsJson).length }, 201);
  },
  { permission: PERMISSIONS.checklist_edit }
);

export const PATCH = withId(
  async (id, { req, user }) => {
    // Reorder: { order: [label, label, …] } — full sequence replacement on a draft.
    const body = await parseBody(req, z.object({ order: z.array(z.string().min(1)).min(1) }));
    const instance = await db.checklistInstance.findUnique({ where: { id } });
    if (!instance) throw Errors.notFound("Checklist not found.");
    if (!["DRAFT", "PENDING_APPROVAL"].includes(instance.status)) {
      throw Errors.invalidTransition("Only drafts awaiting review can be reordered.");
    }
    const items = parseChecklistItems(instance.itemsJson);
    const byLabel = new Map(items.map((it) => [it.label, it]));
    const reordered = body.order.map((label) => byLabel.get(label)).filter((it): it is NonNullable<typeof it> => !!it);
    if (reordered.length !== items.length) throw Errors.badRequest("Order list does not match the checklist tasks.");
    await db.checklistInstance.update({ where: { id }, data: { itemsJson: JSON.stringify(reordered) } });
    await audit({
      actorId: user.id, actorEmail: user.email, action: "CHECKLIST_EDITED",
      resourceType: "CHECKLIST_INSTANCE", resourceId: id, metadata: { code: instance.code, reorder: true },
    });
    await emit({
      type: EVENT_TYPES.CHECKLIST_UPDATED, resourceType: "CHECKLIST_INSTANCE", resourceId: id,
      payload: { code: instance.code, reordered: true }, actorType: "USER", actorId: user.id,
    });
    return ok({ reordered: true });
  },
  { permission: PERMISSIONS.checklist_edit }
);
