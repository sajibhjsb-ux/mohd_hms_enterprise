// MOHD.HMS ENTERPRISE — Central checklist template library (AI checklist spec §8).
// GET  /api/v1/checklists/templates — list (any staff with checklist.view; customers excluded)
// POST /api/v1/checklists/templates — create (checklist.template_manage)
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, PM_TEMPLATE_CATEGORIES, CHECKLIST_WORK_TYPES, CHECKLIST_TASK_PRIORITIES, CHECKLIST_RESPONSE_TYPES } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { validateManualItem } from "@/lib/hms/checklist/validate";
import type { ChecklistItemSpec } from "@/lib/hms/checklist/types";

const itemSchema = z.object({
  label: z.string().min(2).max(300),
  description: z.string().max(1000).optional(),
  required: z.boolean().default(false),
  responseType: z.enum(CHECKLIST_RESPONSE_TYPES).default("CHECKBOX"),
  priority: z.enum(CHECKLIST_TASK_PRIORITIES).default("ROUTINE"),
  safetyCritical: z.boolean().optional(),
  expectedResult: z.string().max(300).optional(),
  unit: z.string().max(12).optional(),
  requiresPhoto: z.boolean().optional(),
  failRequiresFinding: z.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().min(3).max(200),
  category: z.string().min(2).max(40),
  workType: z.enum(CHECKLIST_WORK_TYPES).default("GENERAL"),
  equipmentCategory: z.string().max(40).optional(),
  description: z.string().max(2000).optional(),
  items: z.array(itemSchema).min(3, "A template needs at least 3 tasks.").max(80),
  approvalRequired: z.boolean().default(false),
});

export const GET = handler(
  async ({ user }) => {
    // §52 — the internal template library is never exposed to customer portals.
    if (user.role === "CUSTOMER") throw Errors.forbidden();
    const rows = await db.checklistTemplate.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: { versions: { orderBy: { version: "desc" }, take: 5, select: { version: true, changelog: true, createdAt: true } } },
    });
    const categories = [...new Set([...rows.map((r) => r.category), ...PM_TEMPLATE_CATEGORIES])].sort();
    return ok({
      templates: rows.map((r) => ({
        id: r.id, name: r.name, category: r.category, workType: r.workType, equipmentCategory: r.equipmentCategory,
        description: r.description, version: r.version, status: r.status, approvalRequired: r.approvalRequired,
        itemCount: JSON.parse(r.items || "[]").length,
        items: JSON.parse(r.items || "[]") as ChecklistItemSpec[],
        versions: r.versions,
        createdAt: r.createdAt,
      })),
      categories,
      workTypes: CHECKLIST_WORK_TYPES,
    });
  },
  { permission: PERMISSIONS.checklist_view }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    // Deterministic validation of every item (same rules as AI output).
    const items: ChecklistItemSpec[] = [];
    for (const raw of body.items) {
      const item = validateManualItem(raw);
      if (!item) throw Errors.badRequest(`Invalid checklist task: "${(raw as { label?: string }).label ?? ""}".`);
      items.push(item);
    }
    const created = await db.$transaction(async (tx) => {
      const template = await tx.checklistTemplate.create({
        data: {
          name: body.name, category: body.category, workType: body.workType,
          equipmentCategory: body.equipmentCategory ?? "", description: body.description ?? "",
          items: JSON.stringify(items), version: 1, status: "ACTIVE",
          approvalRequired: body.approvalRequired,
          createdById: user.id, approvedById: body.approvalRequired ? null : user.id,
        },
      });
      await tx.checklistTemplateVersion.create({
        data: { templateId: template.id, version: 1, items: JSON.stringify(items), changelog: "Initial version", createdById: user.id },
      });
      return template;
    });
    await audit({
      actorId: user.id, actorEmail: user.email, action: "CHECKLIST_TEMPLATE_CREATED",
      resourceType: "CHECKLIST_TEMPLATE", resourceId: created.id,
      metadata: { name: created.name, category: created.category, workType: created.workType, itemCount: items.length },
    });
    return ok(created, 201);
  },
  { permission: PERMISSIONS.checklist_template_manage }
);
