// MOHD.HMS ENTERPRISE — PM checklist template detail (PM §15/§54).
// GET    — detail incl. how many plans reference the template.
// PATCH  — edit (library-level only; snapshots already copied into plans never change).
// DELETE — soft delete (active:false) — templates are never hard-deleted.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS, PM_CHECKLIST_RESPONSE_TYPES, PM_TEMPLATE_CATEGORIES } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { parseChecklistTemplate, serializeChecklistTemplate } from "@/lib/hms/pm/schedule";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const GET = withId(
  async (id) => {
    const tpl = await db.pmTemplate.findUnique({ where: { id }, include: { _count: { select: { plans: true } } } });
    if (!tpl) throw Errors.notFound("Template not found.");
    return ok({
      id: tpl.id,
      name: tpl.name,
      category: tpl.category,
      description: tpl.description,
      items: tpl.items,
      itemsParsed: parseChecklistTemplate(tpl.items),
      active: tpl.active,
      createdAt: tpl.createdAt,
      updatedAt: tpl.updatedAt,
      plansCount: tpl._count.plans,
    });
  },
  PERMISSIONS.pm_read
);

const itemSchema = z.object({
  label: z.string().min(1, "Checklist label is required."),
  required: z.boolean().default(false),
  responseType: z.enum(PM_CHECKLIST_RESPONSE_TYPES).default("CHECKBOX"),
});

const patchSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  category: z.enum(PM_TEMPLATE_CATEGORIES).optional(),
  description: z.string().max(2000).optional(),
  items: z.array(itemSchema).min(1).optional(),
  active: z.boolean().optional(),
});

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const tpl = await db.pmTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!tpl) throw Errors.notFound("Template not found.");

    const updated = await db.pmTemplate.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.items !== undefined ? { items: serializeChecklistTemplate(body.items.map((i) => ({ ...i, label: i.label.trim() }))) } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_TEMPLATE_CHANGED",
      resourceType: "PM_TEMPLATE",
      resourceId: id,
      metadata: { fields: Object.keys(body) },
    });

    return ok({ ...updated, itemsParsed: parseChecklistTemplate(updated.items) });
  },
  PERMISSIONS.pm_manage
);

export const DELETE = withId(
  async (id, { user }) => {
    const tpl = await db.pmTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!tpl) throw Errors.notFound("Template not found.");

    const updated = await db.pmTemplate.update({ where: { id }, data: { active: false } });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_TEMPLATE_CHANGED",
      resourceType: "PM_TEMPLATE",
      resourceId: id,
      metadata: { deactivated: true },
    });

    return ok({ ...updated, itemsParsed: parseChecklistTemplate(updated.items) });
  },
  PERMISSIONS.pm_manage
);
