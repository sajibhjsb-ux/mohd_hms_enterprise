// MOHD.HMS ENTERPRISE — Duplicate template (§8).
// The duplicate starts INACTIVE with a unique key — it never silently replaces
// the original.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

export const POST = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const template = await db.emailTemplate.findUnique({ where: { id } });
    if (!template) throw Errors.notFound("Email template not found.");
    const body = await parseBody(req, z.object({ name: z.string().min(2).max(120).optional() }));

    let key = `${template.key}_COPY`;
    let n = 2;
    while (await db.emailTemplate.findUnique({ where: { key } })) key = `${template.key}_COPY${n++}`;

    const created = await db.emailTemplate.create({
      data: {
        key, name: body.name ?? `${template.name} (copy)`, category: template.category,
        description: template.description, subject: template.subject, bodyHtml: template.bodyHtml,
        variables: template.variables, isSystem: false, isActive: false, version: 1,
        versions: { create: { version: 1, subject: template.subject, bodyHtml: template.bodyHtml, editedBy: user.email } },
      },
    });
    await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_TEMPLATE_DUPLICATED", resourceType: "EMAIL_TEMPLATE", resourceId: created.id, metadata: { fromKey: template.key, newKey: key } });
    return ok(created);
  },
  { permission: PERMISSIONS.email_templates }
);
