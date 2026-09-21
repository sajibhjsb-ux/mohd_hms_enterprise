// MOHD.HMS ENTERPRISE — Checklist template detail (spec §8/§27: versioned templates).
// GET    /api/v1/checklists/templates/[id] — detail + version history
// PATCH  — edits create a NEW VERSION (approved history is never silently modified)
// DELETE — soft deactivate (keeps history + existing snapshots intact)
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, CHECKLIST_WORK_TYPES } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { validateManualItem } from "@/lib/hms/checklist/validate";
import type { SessionUser } from "@/lib/hms/auth";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

export const GET = withId(
  async (id) => {
    const template = await db.checklistTemplate.findUnique({
      where: { id },
      include: {
        versions: { orderBy: { version: "desc" }, select: { id: true, version: true, changelog: true, createdAt: true, createdById: true } },
        _count: { select: { instances: true } },
      },
    });
    if (!template) throw Errors.notFound("Template not found.");
    return ok({ ...template, items: JSON.parse(template.items || "[]") });
  },
  { permission: PERMISSIONS.checklist_view }
);

const patchSchema = z.object({
  name: z.string().min(3).max(200).optional(),
  category: z.string().min(2).max(40).optional(),
  workType: z.enum(CHECKLIST_WORK_TYPES).optional(),
  equipmentCategory: z.string().max(40).optional(),
  description: z.string().max(2000).optional(),
  items: z.array(z.record(z.string(), z.unknown())).min(3).max(80).optional(),
  approvalRequired: z.boolean().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  changelog: z.string().max(500).optional(),
});

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const template = await db.checklistTemplate.findUnique({ where: { id } });
    if (!template) throw Errors.notFound("Template not found.");

    // Item changes → NEW VERSION (spec §8 "Templates should be versioned" + §27).
    let itemsJson = template.items;
    let newVersion = template.version;
    let versionCreated = false;
    if (body.items) {
      const items: import("@/lib/hms/checklist/types").ChecklistItemSpec[] = [];
      for (const raw of body.items) {
        const item = validateManualItem(raw);
        if (!item) throw Errors.badRequest("Invalid checklist task in items.");
        items.push(item);
      }
      itemsJson = JSON.stringify(items);
      newVersion = template.version + 1;
      versionCreated = true;
    }
    const updated = await db.$transaction(async (tx) => {
      if (versionCreated) {
        await tx.checklistTemplateVersion.create({
          data: { templateId: id, version: newVersion, items: itemsJson, changelog: body.changelog?.slice(0, 500) ?? "Updated tasks", createdById: user.id },
        });
      }
      return tx.checklistTemplate.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.workType !== undefined ? { workType: body.workType } : {}),
          ...(body.equipmentCategory !== undefined ? { equipmentCategory: body.equipmentCategory } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.approvalRequired !== undefined ? { approvalRequired: body.approvalRequired } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          version: newVersion,
          ...(versionCreated ? { items: itemsJson } : {}),
        },
      });
    });
    await audit({
      actorId: user.id, actorEmail: user.email,
      action: versionCreated ? "CHECKLIST_TEMPLATE_VERSION_CREATED" : "CHECKLIST_TEMPLATE_UPDATED",
      resourceType: "CHECKLIST_TEMPLATE", resourceId: id,
      metadata: { name: updated.name, version: newVersion },
    });
    return ok(updated);
  },
  { permission: PERMISSIONS.checklist_template_manage }
);

export const DELETE = withId(
  async (id, { user }) => {
    const template = await db.checklistTemplate.findUnique({ where: { id } });
    if (!template) throw Errors.notFound("Template not found.");
    await db.checklistTemplate.update({ where: { id }, data: { status: "INACTIVE" } });
    await audit({
      actorId: user.id, actorEmail: user.email, action: "CHECKLIST_TEMPLATE_DEACTIVATED",
      resourceType: "CHECKLIST_TEMPLATE", resourceId: id, metadata: { name: template.name },
    });
    return ok({ deactivated: true });
  },
  { permission: PERMISSIONS.checklist_template_manage }
);
