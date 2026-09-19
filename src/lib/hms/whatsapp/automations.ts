// MOHD.HMS ENTERPRISE — WhatsApp automation engine (§30/§70).
// Event-driven OUTBOUND automations on REAL DomainEvents — the same outbox
// engine the email system uses (registerWorkflow on the shared registry).
// Per-event-per-automation idempotency via WhatsAppMessage @@unique([eventId,
// automationId]); dedupe windows; recipient eligibility (§41); business data
// privacy — customers only ever receive data about their own records (§43).

import { db } from "@/lib/db";
import { formatCurrency } from "@/lib/hms/format";
import { LOCALIZATION } from "@/lib/hms/constants";
import { getBranding } from "@/lib/hms/pdf/branding";
import { queueDirect, resolveRecipients } from "./service";
import { AUTOMATION_SEEDS } from "./templates";
import type { WhatsAppAttachmentKind, WhatsAppRecipientRule } from "./types";

// Real event types this integration serves (subset of EVENT_TYPES in use).
export const WHATSAPP_AUTOMATION_EVENTS = [
  "COMPLAINT_CREATED", "COMPLAINT_ASSIGNED",
  "WORK_ORDER_ASSIGNED", "WORK_ORDER_COMPLETED",
  "QUOTATION_SENT", "INVOICE_SENT", "PAYMENT_RECEIVED",
] as const;

const dateStr = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: LOCALIZATION.timezone }).format(d) : "";
const money = (cents: number | null | undefined) => formatCurrency((cents ?? 0) / 100);

async function companyVars(): Promise<Record<string, string>> {
  const brand = await getBranding().catch(() => null);
  return { COMPANY_NAME: brand?.company || "MOHD.HMS Enterprise" };
}

type AutomationCtx = { eventId: string; eventType: string; resourceType: string; resourceId: string; payload: Record<string, unknown> };

/**
 * Resolve the event → { variables, customerId, userId, attachments } from
 * authorized data. The event payload is a hint; the DB is authoritative.
 */
async function resolveEvent(ctx: AutomationCtx): Promise<{
  vars: Record<string, string>; customerId?: string | null; userId?: string | null;
  attachments: WhatsAppAttachmentKind[]; relatedType: string; relatedId: string;
} | { error: string }> {
  const base = await companyVars();
  const { resourceType, resourceId } = ctx;

  if (resourceType === "COMPLAINT" && (ctx.eventType === "COMPLAINT_CREATED" || ctx.eventType === "COMPLAINT_ASSIGNED")) {
    const c = await db.complaint.findUnique({
      where: { id: resourceId },
      select: { code: true, title: true, priority: true, customerId: true, assignedTechnician: { select: { userId: true } } },
    });
    if (!c) return { error: "complaint not found" };
    return {
      vars: { ...base, COMPLAINT_NUMBER: c.code, COMPLAINT_TITLE: c.title || "", PRIORITY: c.priority || "" },
      customerId: c.customerId,
      userId: ctx.eventType === "COMPLAINT_ASSIGNED" ? (c.assignedTechnician?.userId ?? ctx.payload.userId as string ?? null) : null,
      attachments: [],
      relatedType: "COMPLAINT", relatedId: resourceId,
    };
  }

  if (resourceType === "WORK_ORDER" && (ctx.eventType === "WORK_ORDER_ASSIGNED" || ctx.eventType === "WORK_ORDER_COMPLETED")) {
    const w = await db.workOrder.findUnique({
      where: { id: resourceId },
      select: { code: true, title: true, priority: true, customerId: true, technicianId: true },
    });
    if (!w) return { error: "work order not found" };
    return {
      vars: { ...base, WORK_ORDER_NUMBER: w.code, WORK_ORDER_TITLE: w.title || "", PRIORITY: w.priority || "" },
      customerId: w.customerId,
      userId: ctx.eventType === "WORK_ORDER_ASSIGNED" ? (w.technicianId ?? ctx.payload.userId as string ?? null) : null,
      attachments: [],
      relatedType: "WORK_ORDER", relatedId: resourceId,
    };
  }

  if (resourceType === "QUOTATION" && ctx.eventType === "QUOTATION_SENT") {
    const q = await db.quotation.findUnique({
      where: { id: resourceId },
      select: { code: true, totalCents: true, validUntil: true, customerId: true },
    });
    if (!q) return { error: "quotation not found" };
    return {
      vars: { ...base, QUOTATION_NUMBER: q.code, AMOUNT: money(q.totalCents), DUE_DATE: dateStr(q.validUntil) },
      customerId: q.customerId, userId: null,
      attachments: ["QUOTATION_PDF"],
      relatedType: "QUOTATION", relatedId: resourceId,
    };
  }

  if (resourceType === "INVOICE" && (ctx.eventType === "INVOICE_SENT" || ctx.eventType === "PAYMENT_RECEIVED")) {
    const inv = await db.invoice.findUnique({
      where: { id: resourceId },
      select: { code: true, totalCents: true, dueDate: true, customerId: true },
    });
    if (!inv) return { error: "invoice not found" };
    const amount = ctx.eventType === "PAYMENT_RECEIVED" && typeof ctx.payload.amountCents === "number" ? ctx.payload.amountCents : inv.totalCents;
    return {
      vars: { ...base, INVOICE_NUMBER: inv.code, AMOUNT: money(amount), DUE_DATE: dateStr(inv.dueDate) },
      customerId: inv.customerId, userId: null,
      attachments: ctx.eventType === "INVOICE_SENT" ? ["INVOICE_PDF"] : [],
      relatedType: "INVOICE", relatedId: resourceId,
    };
  }

  return { error: `unsupported ${ctx.eventType}/${resourceType}` };
}

/**
 * Run all enabled WhatsAppAutomations for one DomainEvent. Returns counts +
 * skip reasons (mirrors runEmailAutomations).
 */
export async function runWhatsAppAutomations(ctx: AutomationCtx): Promise<{ queued: number; skipped: string[] }> {
  const skipped: string[] = [];

  // Channel gate — the shared automation setting (off by default until the
  // admin enables WhatsApp automation).
  const { isAutomationEnabled } = await import("@/lib/hms/workflows/settings");
  if (!(await isAutomationEnabled("whatsapp_notifications"))) {
    return { queued: 0, skipped: ["whatsapp_notifications setting is off"] };
  }

  const rules = await db.whatsAppAutomation.findMany({ where: { eventType: ctx.eventType, enabled: true } });
  if (!rules.length) return { queued: 0, skipped: ["no automations registered"] };

  const resolved = await resolveEvent(ctx);
  if ("error" in resolved) return { queued: 0, skipped: [resolved.error] };

  let queued = 0;
  for (const rule of rules) {
    // Per-event per-automation idempotency (DB unique [eventId, automationId]).
    const dup = await db.whatsAppMessage.findFirst({ where: { eventId: ctx.eventId, automationId: rule.id } });
    if (dup) { skipped.push(`${rule.name}: already processed`); continue; }

    // Dedupe window — protects against reminder storms (§70).
    if (rule.dedupeHours > 0 && resolved.relatedId) {
      const since = new Date(Date.now() - rule.dedupeHours * 3600_000);
      const recent = await db.whatsAppMessage.findFirst({
        where: { automationId: rule.id, relatedType: resolved.relatedType, relatedId: resolved.relatedId, createdAt: { gte: since }, status: { notIn: ["FAILED", "CANCELED"] } },
        select: { id: true },
      });
      if (recent) { skipped.push(`${rule.name}: dedupe window (${rule.dedupeHours}h)`); continue; }
    }

    // Conditions (simple equality guards on the payload) — email-style.
    const conditions = safeParseConditions(rule.conditions);
    const condOk = conditions.every((c) => String(ctx.payload[c.field] ?? "") === c.value);
    if (conditions.length && !condOk) { skipped.push(`${rule.name}: conditions not met`); continue; }

    // Recipient eligibility (§41): resolved from the authoritative record.
    const recipients = await resolveRecipients(safeParseRule(rule.recipientRule), {
      customerId: resolved.customerId, userId: resolved.userId,
    });
    if (!recipients.phones.length) { skipped.push(`${rule.name}: ${recipients.skipped[0] ?? "no recipient"}`); continue; }

    for (const phone of recipients.phones) {
      const res = await queueDirect({
        templateKey: rule.templateKey,
        toPhone: phone,
        category: "NOTIFICATION",
        data: resolved.vars,
        relatedType: resolved.relatedType,
        relatedId: resolved.relatedId,
        eventId: ctx.eventId,
        automationId: rule.id,
        attachments: resolved.attachments,
      });
      if (res.ok) queued += 1;
      else skipped.push(`${rule.name}: ${res.reason ?? "queue failed"}`);
    }
  }
  return { queued, skipped };
}

function safeParseRule(json: string): WhatsAppRecipientRule {
  try {
    const v = JSON.parse(json) as WhatsAppRecipientRule;
    if (v && typeof v.kind === "string") return v;
  } catch { /* fallthrough */ }
  return { kind: "CUSTOMER" };
}

function safeParseConditions(json: string): { field: string; value: string }[] {
  try {
    const v = JSON.parse(json) as { field: string; op?: string; value: unknown }[];
    if (!Array.isArray(v)) return [];
    return v.filter((c) => c && typeof c.field === "string").map((c) => ({ field: c.field, value: String(c.value ?? "") }));
  } catch { return []; }
}

export function whatsappAutomationSeeds() {
  return AUTOMATION_SEEDS;
}
