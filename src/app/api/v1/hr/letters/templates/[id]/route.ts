// MOHD.HMS ENTERPRISE — Single letter template API (§3/§27/§28).
//
//   GET    /api/v1/hr/letters/templates/{id}  — detail incl. version history
//   PATCH  /api/v1/hr/letters/templates/{id}  — update (content edit bumps the
//          version and writes an immutable version snapshot)
//   DELETE /api/v1/hr/letters/templates/{id}  — archive (templates referenced
//          by letters are never hard-deleted — auditability §27)

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { TEMPLATE_FIELD_TYPES, validateFieldKey } from "@/lib/hms/letters/shared";
import { safeParseFields, templateToDto, versionToDto } from "@/lib/hms/letters/server";
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

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(1000).optional(),
  department: z.string().max(20).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional(),
  effectiveDate: z.string().datetime().nullable().optional(),
  isDefault: z.boolean().optional(),
  aiInstructions: z.string().max(4000).optional(),
  subjectHint: z.string().max(400).optional(),
  bodyTemplate: z.string().max(20000).optional(),
  closingTemplate: z.string().max(400).optional(),
  fields: z.array(fieldSchema).max(60).optional(),
});

async function loadTemplate(id: string) {
  const t = await db.letterTemplate.findUnique({ where: { id }, include: { _count: { select: { letters: true } } } });
  if (!t) throw Errors.notFound("Letter template not found.");
  return t;
}

export const GET = handler(
  async ({ req }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
    const t = await loadTemplate(id);
    const versions = await db.letterTemplateVersion.findMany({
      where: { templateId: t.id },
      orderBy: { version: "desc" },
      select: { id: true, version: true, createdByName: true, createdAt: true },
    });
    return ok({ ...templateToDto(t), versions: versions.map(versionToDto) });
  },
  { permission: PERMISSIONS.letters_view }
);

export const PATCH = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
    const body = await parseBody(req, updateSchema);
    const current = await loadTemplate(id);

    // Content-bearing fields trigger a version bump + snapshot (§27).
    const contentChanged =
      (body.bodyTemplate !== undefined && body.bodyTemplate !== current.bodyTemplate) ||
      (body.subjectHint !== undefined && body.subjectHint !== current.subjectHint) ||
      (body.aiInstructions !== undefined && body.aiInstructions !== current.aiInstructions) ||
      (body.closingTemplate !== undefined && body.closingTemplate !== current.closingTemplate) ||
      (body.fields !== undefined && JSON.stringify(body.fields) !== JSON.stringify(safeParseFields(current.fieldsJson)));

    const updated = await db.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.letterTemplate.updateMany({
          where: { letterType: current.letterType, isDefault: true, id: { not: current.id } },
          data: { isDefault: false },
        });
      }
      const nextVersion = contentChanged ? current.version + 1 : current.version;
      const t = await tx.letterTemplate.update({
        where: { id: current.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.department !== undefined ? { department: body.department } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.effectiveDate !== undefined ? { effectiveDate: body.effectiveDate ? new Date(body.effectiveDate) : null } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          ...(body.aiInstructions !== undefined ? { aiInstructions: body.aiInstructions } : {}),
          ...(body.subjectHint !== undefined ? { subjectHint: body.subjectHint } : {}),
          ...(body.bodyTemplate !== undefined ? { bodyTemplate: body.bodyTemplate } : {}),
          ...(body.closingTemplate !== undefined ? { closingTemplate: body.closingTemplate } : {}),
          ...(body.fields !== undefined ? { fieldsJson: JSON.stringify(body.fields) } : {}),
          version: nextVersion,
          updatedById: user.id,
        },
        include: { _count: { select: { letters: true } } },
      });
      if (contentChanged) {
        await tx.letterTemplateVersion.create({
          data: {
            templateId: t.id,
            version: nextVersion,
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
      }
      return t;
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: contentChanged ? "LETTER_TEMPLATE_VERSION_CREATED" : "LETTER_TEMPLATE_UPDATED",
      resourceType: "LETTER_TEMPLATE",
      resourceId: updated.id,
      metadata: { code: updated.code, version: updated.version },
      ip: req.headers.get("x-forwarded-for") ?? "",
    });

    return ok(templateToDto(updated));
  },
  { permission: PERMISSIONS.letters_templates }
);

export const DELETE = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
    const t = await loadTemplate(id);

    // Templates used by letters are archived, never deleted (§27 audit trail).
    if (t._count.letters > 0) {
      const archived = await db.letterTemplate.update({ where: { id: t.id }, data: { status: "ARCHIVED", isDefault: false, updatedById: user.id } });
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "LETTER_TEMPLATE_ARCHIVED",
        resourceType: "LETTER_TEMPLATE",
        resourceId: t.id,
        metadata: { code: t.code, reason: "in use by letters" },
        ip: req.headers.get("x-forwarded-for") ?? "",
      });
      return ok(templateToDto(archived));
    }

    await db.letterTemplate.delete({ where: { id: t.id } });
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "LETTER_TEMPLATE_DELETED",
      resourceType: "LETTER_TEMPLATE",
      resourceId: t.id,
      metadata: { code: t.code },
      ip: req.headers.get("x-forwarded-for") ?? "",
    });
    return ok({ deleted: true });
  },
  { permission: PERMISSIONS.letters_templates }
);
