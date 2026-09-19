// MOHD.HMS ENTERPRISE — WhatsApp automation detail: PATCH (toggle/edit) + DELETE.
// Security-critical disable of a critical automation stays SUPER_ADMIN-only —
// same guard as the email automations.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, ROLES } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

function idFromUrl(req: Request): string {
  return new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
}

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  templateKey: z.string().min(2).max(60).optional(),
  enabled: z.boolean().optional(),
  dedupeHours: z.number().int().min(0).max(720).optional(),
});

export const PATCH = handler(async ({ req, user }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const row = await db.whatsAppAutomation.findUnique({ where: { id } });
  if (!row) throw Errors.notFound("Automation not found.");
  const body = await parseBody(req, patchSchema);
  // Critical automations cannot be disabled by plain admins.
  if (body.enabled === false && row.critical && user.role !== ROLES.SUPER_ADMIN) {
    throw Errors.forbidden("Only a Super Admin can disable a critical automation.");
  }
  if (body.templateKey) {
    const tpl = await db.whatsAppTemplate.findUnique({ where: { key: body.templateKey } });
    if (!tpl) throw Errors.badRequest("Template key does not exist.");
  }
  const updated = await db.whatsAppAutomation.update({
    where: { id },
    data: {
      ...(body.name ? { name: body.name } : {}),
      ...(body.templateKey ? { templateKey: body.templateKey } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.dedupeHours !== undefined ? { dedupeHours: body.dedupeHours } : {}),
    },
  });
  void audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_AUTOMATION_UPDATED",
    resourceType: "WHATSAPP_AUTOMATION", resourceId: id,
    metadata: { name: updated.name, enabled: updated.enabled },
  });
  return ok(updated);
}, { permission: PERMISSIONS.whatsapp_automations });

export const DELETE = handler(async ({ req, user }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const row = await db.whatsAppAutomation.findUnique({ where: { id } });
  if (!row) throw Errors.notFound("Automation not found.");
  if (row.critical && user.role !== ROLES.SUPER_ADMIN) {
    throw Errors.forbidden("Only a Super Admin can delete a critical automation.");
  }
  await db.whatsAppAutomation.delete({ where: { id } });
  void audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_AUTOMATION_DELETED",
    resourceType: "WHATSAPP_AUTOMATION", resourceId: id, metadata: { name: row.name },
  });
  return ok({ ok: true });
}, { permission: PERMISSIONS.whatsapp_automations });
