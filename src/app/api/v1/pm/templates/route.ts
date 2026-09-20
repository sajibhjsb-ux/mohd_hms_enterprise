// MOHD.HMS ENTERPRISE — PM checklist template library (PM §15/§54).
// GET  /api/v1/pm/templates — library list (+ categories, rich + raw items).
// POST /api/v1/pm/templates — create a reusable template (snapshot is copied
// into plans at assignment; historical plans never mutate).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, PM_CHECKLIST_RESPONSE_TYPES, PM_TEMPLATE_CATEGORIES } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { parseChecklistTemplate, serializeChecklistTemplate } from "@/lib/hms/pm/schedule";

export const GET = handler(
  async ({ req, user }) => {
    // §44 — the template library is internal; customers never browse it.
    if (user.role === "CUSTOMER") throw Errors.forbidden();
    const sp = new URL(req.url).searchParams;
    const category = (sp.get("category") ?? "").trim();
    const active = (sp.get("active") ?? "").trim();

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (active === "1") where.active = true;

    const [rows, activeCategories] = await Promise.all([
      db.pmTemplate.findMany({ where, orderBy: [{ category: "asc" }, { name: "asc" }] }),
      db.pmTemplate.findMany({ where: { active: true }, select: { category: true }, distinct: ["category"] }),
    ]);

    const categories = [...new Set([...PM_TEMPLATE_CATEGORIES, ...activeCategories.map((c) => c.category)])];

    return ok({
      templates: rows.map((t) => ({ ...t, itemsParsed: parseChecklistTemplate(t.items) })),
      categories,
    });
  },
  { permission: PERMISSIONS.pm_read }
);

const itemSchema = z.object({
  label: z.string().min(1, "Checklist label is required."),
  required: z.boolean().default(false),
  responseType: z.enum(PM_CHECKLIST_RESPONSE_TYPES).default("CHECKBOX"),
});

const createSchema = z.object({
  name: z.string().min(2, "Template name must be at least 2 characters.").max(200),
  category: z.enum(PM_TEMPLATE_CATEGORIES).default("GENERAL"),
  description: z.string().max(2000).default(""),
  items: z.array(itemSchema).min(1, "Add at least one checklist item."),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    const created = await db.pmTemplate.create({
      data: {
        name: body.name,
        category: body.category,
        description: body.description,
        items: serializeChecklistTemplate(body.items.map((i) => ({ ...i, label: i.label.trim() }))),
        createdById: user.id,
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_TEMPLATE_CREATED",
      resourceType: "PM_TEMPLATE",
      resourceId: created.id,
      metadata: { name: created.name, category: created.category, items: body.items.length },
    });

    return ok({ ...created, itemsParsed: parseChecklistTemplate(created.items) }, 201);
  },
  { permission: PERMISSIONS.pm_manage }
);
