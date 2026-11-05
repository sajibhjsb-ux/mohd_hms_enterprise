// MOHD.HMS ENTERPRISE — Duplicate a checklist template.
// Copies category, work type, description and items into a new ACTIVE template
// (version 1) without touching existing work-order snapshots.
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import type { SessionUser } from "@/lib/hms/auth";
import { parseChecklistItems } from "@/lib/hms/checklist/types";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

const duplicateSchema = z.object({
  name: z.string().min(3, "Name must be at least 3 characters.").max(200).optional(),
});

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, duplicateSchema);
    const template = await db.checklistTemplate.findUnique({ where: { id } });
    if (!template) throw Errors.notFound("Template not found.");

    const items = parseChecklistItems(template.items);
    if (items.length === 0) throw Errors.badRequest("This template has no tasks to duplicate.");

    const created = await db.$transaction(async (tx) => {
      const copy = await tx.checklistTemplate.create({
        data: {
          name: (body.name ?? `${template.name} (copy)`).trim(),
          category: template.category,
          workType: template.workType,
          equipmentCategory: template.equipmentCategory,
          description: template.description,
          items: template.items,
          version: 1,
          status: "ACTIVE",
          approvalRequired: template.approvalRequired,
          createdById: user.id,
        },
      });
      await tx.checklistTemplateVersion.create({
        data: {
          templateId: copy.id, version: 1, items: template.items, changelog: `Duplicated from ${template.name}`, createdById: user.id,
        },
      });
      return copy;
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "CHECKLIST_TEMPLATE_DUPLICATED",
      resourceType: "CHECKLIST_TEMPLATE", resourceId: created.id,
      metadata: { sourceTemplateId: id, sourceTemplateName: template.name, name: created.name, itemCount: items.length },
    });
    return ok(created, 201);
  },
  { permission: PERMISSIONS.checklist_template_manage }
);
