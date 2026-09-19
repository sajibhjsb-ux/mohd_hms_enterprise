// MOHD.HMS ENTERPRISE — Email automations API (§15/§32).
// GET  — list automations (+ latest sends summary)
// POST — create; event types and template keys are validated against the
//        registry/catalog; recipients come from the controlled rule schema.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { EMAIL_AUTOMATION_EVENTS } from "@/lib/hms/email/workflows";
import { EMAIL_CATEGORIES } from "@/lib/hms/email/types";

const recipientRuleSchema = z.object({
  kind: z.enum(["CUSTOMER", "RELATED_USER", "ROLE", "MODULE_MAILBOX", "FIXED"]),
  value: z.string().max(254).optional(),
});

const conditionSchema = z.object({
  field: z.string().regex(/^[A-Za-z0-9_.]{1,60}$/),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "exists"]),
  value: z.union([z.string().max(300), z.number(), z.boolean()]).optional(),
});

const attachmentSchema = z.object({
  kind: z.enum(["INVOICE_PDF", "QUOTATION_PDF", "WO_PDF", "INSPECTION_PDF", "LETTER_PDF", "PAYMENT_RECEIPT_PDF"]),
});

export const AUTOMATION_INPUT = {
  name: z.string().min(2).max(120),
  eventType: z.string().max(60).refine((v) => (EMAIL_AUTOMATION_EVENTS as readonly string[]).includes(v) || v.startsWith("__OTP_"), "Unsupported event type."),
  templateKey: z.string().max(60),
  recipientRule: recipientRuleSchema,
  senderName: z.string().max(120).default(""),
  senderEmail: z.string().max(254).default(""),
  replyTo: z.string().max(254).default(""),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
  conditions: z.array(conditionSchema).max(10).default([]),
  attachments: z.array(attachmentSchema).max(3).default([]),
  enabled: z.boolean().default(true),
  critical: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  dedupeHours: z.number().int().min(0).max(720).default(0),
};

export const GET = handler(
  async ({ req }) => {
    const url = new URL(req.url);
    const eventType = url.searchParams.get("eventType") ?? "";
    const rows = await db.emailAutomation.findMany({
      where: eventType ? { eventType } : {},
      orderBy: [{ eventType: "asc" }, { name: "asc" }],
    });
    // Automations reference templates by canonical key (no FK) — join manually.
    const templateKeys = [...new Set(rows.map((r) => r.templateKey))];
    const templates = templateKeys.length
      ? await db.emailTemplate.findMany({ where: { key: { in: templateKeys } }, select: { key: true, name: true, category: true, isActive: true } })
      : [];
    const tplByKey = new Map(templates.map((t) => [t.key, t]));
    // Recent per-automation activity for the admin list (real data, §32).
    const recent = await db.emailLog.groupBy({
      by: ["automationId", "status"],
      where: { automationId: { not: null }, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      _count: { _all: true },
    }).catch(() => []);
    const counts = new Map<string, { sent: number; failed: number; queued: number }>();
    for (const r of recent) {
      if (!r.automationId) continue;
      const c = counts.get(r.automationId) ?? { sent: 0, failed: 0, queued: 0 };
      if (r.status === "SENT") c.sent += r._count._all;
      else if (r.status === "DEAD_LETTER" || r.status === "FAILED") c.failed += r._count._all;
      else c.queued += r._count._all;
      counts.set(r.automationId, c);
    }
    return ok(rows.map((a) => ({
      ...a,
      template: tplByKey.get(a.templateKey) ?? null,
      recent: counts.get(a.id) ?? { sent: 0, failed: 0, queued: 0 },
      categories: EMAIL_CATEGORIES,
      events: EMAIL_AUTOMATION_EVENTS,
    })));
  },
  { permission: PERMISSIONS.email_view }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, z.object(AUTOMATION_INPUT));
    if (!(await db.emailTemplate.findUnique({ where: { key: body.templateKey }, select: { key: true } }))) {
      throw Errors.badRequest(`Template key ${body.templateKey} does not exist.`);
    }
    if (await db.emailAutomation.findUnique({ where: { eventType_name: { eventType: body.eventType, name: body.name } } })) {
      throw Errors.conflict("An automation with this name already exists for the event.");
    }
    const created = await db.emailAutomation.create({
      data: {
        name: body.name, eventType: body.eventType, templateKey: body.templateKey,
        recipientRule: JSON.stringify(body.recipientRule),
        senderName: body.senderName, senderEmail: body.senderEmail, replyTo: body.replyTo,
        delayMinutes: body.delayMinutes, conditions: JSON.stringify(body.conditions),
        attachments: JSON.stringify(body.attachments), enabled: body.enabled,
        critical: body.critical, maxAttempts: body.maxAttempts, dedupeHours: body.dedupeHours,
      },
    });
    await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_AUTOMATION_CREATED", resourceType: "EMAIL_AUTOMATION", resourceId: created.id, metadata: { name: created.name, eventType: created.eventType, templateKey: created.templateKey } });
    return ok(created, 201);
  },
  { permission: PERMISSIONS.email_automations }
);
