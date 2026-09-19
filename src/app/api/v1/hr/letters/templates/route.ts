// MOHD.HMS ENTERPRISE — Letter templates collection API (§3/§4).
//
//   GET  /api/v1/hr/letters/templates  — list templates (letters.view)
//   POST /api/v1/hr/letters/templates  — create a template (letters.templates)

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { LETTER_TYPES, TEMPLATE_FIELD_TYPES, validateFieldKey } from "@/lib/hms/letters/shared";
import { ensureLetterTemplatesBootstrapped } from "@/lib/hms/letters/bootstrap";
import { safeParseFields, templateToDto } from "@/lib/hms/letters/server";
import { audit } from "@/lib/hms/services";

const fieldSchema = z.object({
  key: z.string().refine(validateFieldKey, "Field key must be UPPER_SNAKE_CASE (2-40 chars)."),
  label: z.string().min(1).max(80),
  type: z.enum(TEMPLATE_FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().max(120)).max(30).optional(),
  hint: z.string().max(300).optional(),
  ai: z.boolean().optional(),
});

const createSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9-]+$/, "Template code must be uppercase letters/digits/dashes, e.g. LOU-002."),
  name: z.string().min(2).max(120),
  letterType: z.enum(LETTER_TYPES),
  description: z.string().max(1000).default(""),
  department: z.string().max(20).default("HR"),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).default("ACTIVE"),
  effectiveDate: z.string().datetime().nullable().optional(),
  isDefault: z.boolean().default(false),
  aiInstructions: z.string().max(4000).default(""),
  subjectHint: z.string().max(400).default(""),
  bodyTemplate: z.string().max(20000).default(""),
  closingTemplate: z.string().max(400).default("Yours faithfully,"),
  fields: z.array(fieldSchema).max(60).default([]),
});

export const GET = handler(
  async ({ req }) => {
    await ensureLetterTemplatesBootstrapped();
    const q = listQuery(req);
    const where = {
      AND: [
        q.status ? { status: q.status } : {},
        q.search
          ? {
              OR: [
                { code: { contains: q.search } },
                { name: { contains: q.search } },
                { letterType: { contains: q.search } },
                { description: { contains: q.search } },
              ],
            }
          : {},
      ],
    };
    const [templates, total] = await Promise.all([
      db.letterTemplate.findMany({
        where,
        orderBy: [{ letterType: "asc" }, { version: "desc" }],
        skip: q.skip,
        take: q.take,
        include: { _count: { select: { letters: true } } },
      }),
      db.letterTemplate.count({ where }),
    ]);
    return okList(templates.map(templateToDto), pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.letters_view }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    // Duplicate code is a conflict; duplicate (type,isDefault) resolves by
    // unsetting the previous default inside the create transaction below.
    const dup = await db.letterTemplate.findUnique({ where: { code: body.code }, select: { id: true } });
    if (dup) throw Errors.conflict(`Template code ${body.code} is already in use.`);

    const template = await db.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.letterTemplate.updateMany({ where: { letterType: body.letterType, isDefault: true }, data: { isDefault: false } });
      }
      const t = await tx.letterTemplate.create({
        data: {
          code: body.code,
          name: body.name,
          letterType: body.letterType,
          description: body.description,
          department: body.department,
          status: body.status,
          effectiveDate: body.effectiveDate ? new Date(body.effectiveDate) : null,
          isDefault: body.isDefault,
          aiInstructions: body.aiInstructions,
          subjectHint: body.subjectHint,
          bodyTemplate: body.bodyTemplate,
          closingTemplate: body.closingTemplate || "Yours faithfully,",
          fieldsJson: JSON.stringify(body.fields),
          createdById: user.id,
          updatedById: user.id,
        },
      });
      // Version 1 snapshot — every template starts versioned (§27).
      await tx.letterTemplateVersion.create({
        data: {
          templateId: t.id,
          version: 1,
          snapshotJson: JSON.stringify({
            name: t.name,
            letterType: t.letterType,
            subjectHint: t.subjectHint,
            aiInstructions: t.aiInstructions,
            bodyTemplate: t.bodyTemplate,
            closingTemplate: t.closingTemplate,
            fields: safeParseFields(t.fieldsJson),
            pageSize: t.pageSize,
            language: t.language,
          }),
          createdById: user.id,
          createdByName: user.name,
        },
      });
      return t;
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "LETTER_TEMPLATE_CREATED",
      resourceType: "LETTER_TEMPLATE",
      resourceId: template.id,
      metadata: { code: template.code, letterType: template.letterType },
      ip: req.headers.get("x-forwarded-for") ?? "",
    });

    const withCount = await db.letterTemplate.findUnique({
      where: { id: template.id },
      include: { _count: { select: { letters: true } } },
    });
    return ok(templateToDto(withCount!), 201);
  },
  { permission: PERMISSIONS.letters_templates }
);
