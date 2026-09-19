// MOHD.HMS ENTERPRISE — Duplicate a letter template (§3).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { templateToDto } from "@/lib/hms/letters/server";
import { audit } from "@/lib/hms/services";

const duplicateSchema = z.object({
  code: z.string().min(2).max(40).regex(/^[A-Z0-9-]+$/, "Template code must be uppercase letters/digits/dashes."),
  name: z.string().min(2).max(120).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
    const source = await db.letterTemplate.findUnique({ where: { id } });
    if (!source) throw Errors.notFound("Letter template not found.");

    const body = await parseBody(req, duplicateSchema);
    const dup = await db.letterTemplate.findUnique({ where: { code: body.code }, select: { id: true } });
    if (dup) throw Errors.conflict(`Template code ${body.code} is already in use.`);

    const copy = await db.letterTemplate.create({
      data: {
        code: body.code,
        name: body.name ?? `${source.name} (Copy)`,
        letterType: source.letterType,
        description: source.description,
        department: source.department,
        status: "INACTIVE", // duplicates start inactive until reviewed
        effectiveDate: null,
        isDefault: false, // never inherit default
        aiInstructions: source.aiInstructions,
        subjectHint: source.subjectHint,
        bodyTemplate: source.bodyTemplate,
        closingTemplate: source.closingTemplate,
        fieldsJson: source.fieldsJson,
        createdById: user.id,
        updatedById: user.id,
      },
    });
    await db.letterTemplateVersion.create({
      data: {
        templateId: copy.id,
        version: 1,
        snapshotJson: JSON.stringify({
          name: copy.name,
          letterType: copy.letterType,
          subjectHint: copy.subjectHint,
          aiInstructions: copy.aiInstructions,
          bodyTemplate: copy.bodyTemplate,
          closingTemplate: copy.closingTemplate,
          fields: JSON.parse(source.fieldsJson || "[]"),
          pageSize: copy.pageSize,
          language: copy.language,
        }),
        createdById: user.id,
        createdByName: user.name,
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "LETTER_TEMPLATE_CREATED",
      resourceType: "LETTER_TEMPLATE",
      resourceId: copy.id,
      metadata: { code: copy.code, duplicatedFrom: source.code },
      ip: req.headers.get("x-forwarded-for") ?? "",
    });

    return ok(templateToDto(copy), 201);
  },
  { permission: PERMISSIONS.letters_templates }
);
