// MOHD.HMS ENTERPRISE — WhatsApp template detail: PATCH (versioned edit §38)
// + preview + version history.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { extractVariables, renderTemplate } from "@/lib/hms/whatsapp/templates";

function idFromUrl(req: Request): string {
  return new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
}

export const GET = handler(async ({ req }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const tpl = await db.whatsAppTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: "desc" } } } });
  if (!tpl) throw Errors.notFound("Template not found.");
  return ok(tpl);
}, { permission: PERMISSIONS.whatsapp_view });

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  body: z.string().min(1).max(4000).optional(),
  isActive: z.boolean().optional(),
  // Preview-only: render the (proposed) body with sample values, never persisted.
  preview: z.record(z.string(), z.string()).optional(),
});

export const PATCH = handler(async ({ req, user }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const tpl = await db.whatsAppTemplate.findUnique({ where: { id } });
  if (!tpl) throw Errors.notFound("Template not found.");
  const body = await parseBody(req, patchSchema);

  if (body.preview) {
    const bodyText = body.body ?? tpl.body;
    const allowed = extractVariables(bodyText);
    return ok({ preview: renderTemplate(bodyText, body.preview, allowed) });
  }

  let version = tpl.version;
  let bodyText = tpl.body;
  if (body.body !== undefined && body.body !== tpl.body) {
    // Immutable version snapshot on every content edit (§38).
    version = tpl.version + 1;
    bodyText = body.body;
    await db.whatsAppTemplateVersion.create({
      data: { templateId: tpl.id, version: tpl.version, body: tpl.body, editedBy: user.email },
    });
  }
  const updated = await db.whatsAppTemplate.update({
    where: { id },
    data: {
      ...(body.name ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.body !== undefined ? { body: bodyText } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      version,
      variables: JSON.stringify(extractVariables(bodyText)),
    },
  });
  void audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_TEMPLATE_UPDATED",
    resourceType: "WHATSAPP_TEMPLATE", resourceId: id,
    metadata: { key: tpl.key, version, bodyChanged: body.body !== undefined && body.body !== tpl.body },
  });
  return ok(updated);
}, { permission: PERMISSIONS.whatsapp_templates });
