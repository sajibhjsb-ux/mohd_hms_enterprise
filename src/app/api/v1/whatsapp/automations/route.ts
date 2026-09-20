// MOHD.HMS ENTERPRISE — WhatsApp automations (§36): list + create.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { WHATSAPP_AUTOMATION_EVENTS } from "@/lib/hms/whatsapp/automations";

export const GET = handler(async (): Promise<NextResponse> => {
  const rows = await db.whatsAppAutomation.findMany({ orderBy: [{ eventType: "asc" }, { name: "asc" }] });
  return okList(rows);
}, { permission: PERMISSIONS.whatsapp_view });

const ruleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CUSTOMER") }),
  z.object({ kind: z.literal("RELATED_USER") }),
  z.object({ kind: z.literal("ROLE"), value: z.string().min(2).max(30) }),
  z.object({ kind: z.literal("FIXED"), value: z.string().min(6).max(30) }),
]);

const attachmentKinds = z.enum(["QUOTATION_PDF", "INVOICE_PDF", "WO_PDF", "INSPECTION_PDF", "LETTER_PDF", "PAYMENT_RECEIPT_PDF"]);

const createSchema = z.object({
  name: z.string().min(2).max(120),
  eventType: z.enum(WHATSAPP_AUTOMATION_EVENTS),
  templateKey: z.string().min(2).max(60),
  recipientRule: ruleSchema,
  conditions: z.array(z.object({ field: z.string().regex(/^[A-Za-z0-9_]{1,40}$/), value: z.string().max(200) })).max(10).default([]),
  attachments: z.array(attachmentKinds).max(1).default([]),
  dedupeHours: z.number().int().min(0).max(720).default(0),
  enabled: z.boolean().default(true),
});

export const POST = handler(async ({ req, user }): Promise<NextResponse> => {
  const body = await parseBody(req, createSchema);
  const tpl = await db.whatsAppTemplate.findUnique({ where: { key: body.templateKey } });
  if (!tpl) throw Errors.badRequest("Template key does not exist.");
  const dup = await db.whatsAppAutomation.findUnique({ where: { eventType_name: { eventType: body.eventType, name: body.name } } });
  if (dup) throw Errors.conflict("An automation with this name already exists for this event.");
  const created = await db.whatsAppAutomation.create({
    data: {
      name: body.name, eventType: body.eventType, templateKey: body.templateKey,
      recipientRule: JSON.stringify(body.recipientRule),
      conditions: JSON.stringify(body.conditions),
      attachments: JSON.stringify(body.attachments),
      dedupeHours: body.dedupeHours, enabled: body.enabled,
    },
  });
  void audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_AUTOMATION_CREATED",
    resourceType: "WHATSAPP_AUTOMATION", resourceId: created.id,
    metadata: { name: body.name, eventType: body.eventType },
  });
  return ok(created, 201);
}, { permission: PERMISSIONS.whatsapp_automations });
