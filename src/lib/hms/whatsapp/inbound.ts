// MOHD.HMS ENTERPRISE — inbound WhatsApp processing (§17-§27, §40, §58-§60).
// OpenWA → signed webhook → verify → idempotency → persist/queue → async
// route → business workflow → PostgreSQL → notifications → optional reply.
// Loop prevention (§40): fromMe/system messages are NEVER processed; outbound
// messages are recorded by the send path, not re-entered here.

import crypto from "crypto";
import { db } from "@/lib/db";
import { audit, nextNumber, notifyRole } from "@/lib/hms/services";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { emit } from "@/lib/hms/workflows/bus";
import { formatCurrency } from "@/lib/hms/format";
import { missingCustomerFields } from "@/lib/hms/customer-profile";
import { LOCALIZATION } from "@/lib/hms/constants";
import { getWebhookSecret, getWhatsAppConfig, recordTraffic } from "./config";
import { ensureContact, ensureConversation, queueDirect } from "./service";
import { isLidId, normalizePhone, phoneFromWaId } from "./normalize";
import { loadTemplateByKey, renderTemplate, extractVariables } from "./templates";
import type { OpenWaWebhookDelivery, OpenWaInboundMessage } from "./types";

// ── Webhook verification (§18) ───────────────────────────────────────────────

/**
 * Verify the X-OpenWA-Signature (HMAC-SHA256 over the RAW body bytes) against
 * the configured webhook secret. Constant-time compare. No secret configured
 * ⇒ the endpoint rejects everything (fail-closed).
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | null, secret: string | null): boolean {
  if (!secret || !signatureHeader) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!m) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(m[1], "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Idempotency anchor (§20) ─────────────────────────────────────────────────

export type IngestResult = { processed: boolean; duplicate: boolean; event: string; idempotencyKey: string };

/**
 * Persist the delivery FIRST (unique idempotencyKey = dedupe anchor), then
 * process asynchronously. Duplicate deliveries are acknowledged (200) but
 * never re-processed — no double complaints, no double auto-replies.
 */
export async function ingestWebhookDelivery(delivery: OpenWaWebhookDelivery, rawPayload: string): Promise<IngestResult> {
  const key = delivery.idempotencyKey || delivery.deliveryId || "";
  if (!key) {
    // A delivery without an idempotency key cannot be deduped safely: reject.
    return { processed: false, duplicate: false, event: delivery.event || "?", idempotencyKey: "" };
  }
  const created = await db.whatsAppWebhookEvent.create({
    data: {
      idempotencyKey: key,
      deliveryId: delivery.deliveryId ?? "",
      sessionId: delivery.sessionId ?? "",
      event: delivery.event,
      payload: rawPayload.slice(0, 100_000),
      status: "RECEIVED",
    },
  }).catch(() => null);
  if (!created) return { processed: false, duplicate: true, event: delivery.event, idempotencyKey: key };

  // Return quickly (§19); heavy work runs in the same tick but guarded — the
  // engine dispatches webhooks asynchronously, so no long AI work sits on
  // OpenWA's delivery socket. Errors mark the row FAILED for redrive.
  try {
    await routeDelivery(delivery, created.id);
    await db.whatsAppWebhookEvent.update({ where: { id: created.id }, data: { status: "PROCESSED", processedAt: new Date() } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("whatsapp-inbound-route-error", msg);
    // A unique-constraint hit here means the SAME chat/message was already
    // stored under a different delivery key (provider redelivery) — that is
    // a duplicate, not a failure.
    const isDup = /unique constraint/i.test(msg) && /providerMessageId|chatId/i.test(msg);
    await db.whatsAppWebhookEvent.update({
      where: { id: created.id },
      data: { status: isDup ? "DUPLICATE" : "FAILED", error: isDup ? "" : msg.slice(0, 500) },
    }).catch(() => undefined);
  }
  return { processed: true, duplicate: false, event: delivery.event, idempotencyKey: key };
}

async function routeDelivery(delivery: OpenWaWebhookDelivery, rowId: string): Promise<void> {
  const cfg = await getWhatsAppConfig();
  const data = (delivery.data ?? {}) as Record<string, unknown>;
  switch (delivery.event) {
    case "message.received":
      await recordTraffic("inbound").catch(() => undefined);
      if (cfg.enabled && cfg.autoReplies) await handleInboundMessage(data as OpenWaInboundMessage, delivery.sessionId ?? cfg.sessionName);
      break;
    case "message.ack":
    case "message.failed":
      await handleAck(data);
      break;
    case "session.status": {
      const status = typeof data.status === "string" ? data.status : "unknown";
      await db.whatsAppConfig.updateMany({
        where: { id: "singleton" },
        data: {
          sessionStatus: status,
          lastHeartbeatAt: new Date(),
          ...(status === "ready" ? { lastConnectedAt: new Date(), sessionError: "" } : {}),
        },
      }).catch(() => undefined);
      break;
    }
    case "session.authenticated":
      await db.whatsAppConfig.updateMany({
        where: { id: "singleton" },
        data: { sessionStatus: "authenticating", sessionPhone: typeof data.phone === "string" ? data.phone : "", lastHeartbeatAt: new Date() },
      }).catch(() => undefined);
      break;
    case "session.disconnected":
      await db.whatsAppConfig.updateMany({
        where: { id: "singleton" },
        data: { sessionStatus: "disconnected", sessionError: typeof data.reason === "string" ? data.reason.slice(0, 200) : "", lastHeartbeatAt: new Date() },
      }).catch(() => undefined);
      break;
    case "session.qr":
      // QR lifecycle is pull-based (admin clicks "Show QR"); nothing to store.
      break;
    default:
      // Unsubscribed/unknown event types: record only (§17 — no surprises).
      break;
  }
  void rowId;
}

// ── message.ack → delivery status (§29) ──────────────────────────────────────

async function handleAck(data: Record<string, unknown>): Promise<void> {
  const messageId = typeof data.id === "string" ? data.id : typeof data.messageId === "string" ? data.messageId : "";
  const status = typeof data.status === "string" ? data.status.toUpperCase() : "";
  if (!messageId) return;
  const mapped = status === "DELIVERED" ? "DELIVERED" : status === "READ" ? "READ" : status === "SENT" ? "SENT" : status === "FAILED" ? "FAILED" : "";
  if (!mapped) return;
  const msg = await db.whatsAppMessage.findFirst({ where: { providerMessageId: messageId, direction: "OUTBOUND" } });
  if (!msg) return;
  // Deliveries only move forward; FAILED sticks until an admin retries.
  if (["READ", "DELIVERED", "FAILED"].includes(msg.status) && mapped !== "FAILED") return;
  await db.whatsAppMessage.update({
    where: { id: msg.id },
    data: {
      status: mapped,
      ...(mapped === "FAILED" ? { lastError: "Provider reported failure (message.failed)" } : {}),
    },
  }).catch(() => undefined);
}

// ── Inbound message router (§21-§27, §58-§60) ────────────────────────────────

// In-memory per-chat auto-reply throttle (§39/§70): max 3 replies / 5 min.
const g = globalThis as unknown as { __hmsWaReplyThrottle?: Map<string, number[]> };

function replyThrottled(chatId: string): boolean {
  const m = (g.__hmsWaReplyThrottle ??= new Map());
  const now = Date.now();
  const arr = (m.get(chatId) ?? []).filter((t) => now - t < 5 * 60_000);
  if (arr.length >= 3) return true;
  arr.push(now);
  m.set(chatId, arr);
  return false;
}

export async function handleInboundMessage(msg: OpenWaInboundMessage, sessionId: string): Promise<void> {
  void sessionId;
  // ── Loop prevention (§40) ──
  if (msg.fromMe) return;
  if ((msg.kind && msg.kind !== "individual") || msg.isGroup) return; // groups/status/broadcast are never auto-processed

  const chatId = (msg.from || "").toLowerCase();
  if (!chatId) return;

  // Identity: phone-based ids resolve directly; @lid ids only via senderPhone
  // (RESOLVE_LID_TO_PHONE) — never guessed (§42).
  let phone = phoneFromWaId(chatId);
  if (!phone && !isLidId(chatId)) {
    const n = normalizePhone(chatId);
    if (n.ok) phone = n.e164;
  }
  if (!phone && msg.senderPhone) phone = msg.senderPhone.startsWith("+") ? msg.senderPhone : `+${msg.senderPhone}`;
  if (!phone) {
    // Unresolvable sender identity — no auto-response (would leak numbers).
    return;
  }

  const contact = await ensureContact(chatId, phone, msg.contact?.pushName || undefined);
  const conversation = await ensureConversation(chatId, contact.id, contact.customerId);
  const type = mapInboundType(msg.type, msg.hasMedia);

  // ── Media (§32/§33): bytes → MinIO, metadata → message row ──
  let mediaKey = "";
  let mediaMimetype = "";
  let mediaFilename = "";
  let mediaSize = 0;
  let body = (msg.body || "").trim();
  if (msg.hasMedia && msg.id) {
    const stored = await storeInboundMedia(msg, sessionId, chatId);
    if (stored) {
      mediaKey = stored.key;
      mediaMimetype = stored.mimetype;
      mediaFilename = stored.filename;
      mediaSize = stored.size;
      if (!body) body = `[${stored.mimetype.split("/")[0]} attachment]`;
    }
  }

  // Inbound dedupe on provider message id (at-least-once deliveries).
  const providerMessageId = msg.id || "";
  if (providerMessageId) {
    const dup = await db.whatsAppMessage.findUnique({ where: { chatId_providerMessageId_direction: { chatId, providerMessageId, direction: "INBOUND" } } });
    if (dup) return;
  }

  const inbound = await db.whatsAppMessage.create({
    data: {
      conversationId: conversation.id, chatId, contactId: contact.id, direction: "INBOUND",
      status: "RECEIVED", type, body: body.slice(0, MAX_INBOUND_CHARS), fromMe: false,
      mediaKey, mediaMimetype, mediaFilename, mediaSize, providerMessageId,
      relatedType: contact.customerId ? "CUSTOMER" : "", relatedId: contact.customerId ?? "",
    },
  });

  await db.whatsAppConversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: new Date(), lastMessagePreview: body.slice(0, 80),
      lastInboundAt: new Date(), unreadCount: { increment: 1 },
      customerId: contact.customerId ?? conversation.customerId,
    },
  }).catch(() => undefined);
  void inbound;

  // Realtime: staff inbox updates (existing realtime architecture §45).
  await emit({ type: "WHATSAPP_MESSAGE_RECEIVED", resourceType: "WHATSAPP_MESSAGE", resourceId: inbound.id, payload: { chatId, customerId: contact.customerId }, actorType: "SYSTEM" }).catch(() => undefined);

  // ── Automation gates (§26/§41) ──
  if (conversation.state === "HUMAN" || conversation.state === "CLOSED") return; // human handoff: bot silent
  if (!contact.automationEnabled) return;
  if (replyThrottled(chatId)) return;

  // ── Intent routing (§24/§25) ──
  const intent = classifyIntent(body);
  const rctx: ReplyCtx = { chatId, customerId: contact.customerId, contactName: contact.waName || msg.contact?.pushName || "" };
  await routeIntent(intent, body, rctx);
}

const MAX_INBOUND_CHARS = 4000;

function mapInboundType(type: string | undefined, hasMedia: boolean | undefined): string {
  if (!hasMedia) return type && ["text", "location"].includes(type) ? type : "text";
  if (type === "image") return "image";
  if (type === "video") return "video";
  if (type === "audio" || type === "voice") return "audio";
  return "document";
}

// ── Inbound media → MinIO (§32/§33) ──────────────────────────────────────────

const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf", "video/mp4", "audio/ogg", "audio/mpeg", "audio/mp4"];
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

async function storeInboundMedia(msg: OpenWaInboundMessage, sessionId: string, chatId: string): Promise<{ key: string; mimetype: string; filename: string; size: number } | null> {
  try {
    const { getGatewayClientConfig } = await import("./config");
    const gw = await getGatewayClientConfig();
    if (!gw || !msg.id) return null;
    const { getInboundMedia } = await import("./openwa");
    const fetched = await getInboundMedia(gw, sessionId, chatId, msg.id);
    if (!fetched) return null;
    if (fetched.buffer.length === 0 || fetched.buffer.length > MAX_MEDIA_BYTES) return null;
    if (!ALLOWED_MEDIA_TYPES.includes(fetched.mimetype.split(";")[0])) return null;

    const { storage } = await import("@/lib/hms/storage");
    const ext = fetched.mimetype.includes("jpeg") ? "jpg" : fetched.mimetype.split("/")[1]?.split(";")[0] || "bin";
    const key = `whatsapp/inbound/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
    await storage.put(key, fetched.buffer, fetched.mimetype.split(";")[0]);
    return { key, mimetype: fetched.mimetype.split(";")[0], filename: msg.media?.filename || `whatsapp-${msg.id}.${ext}`, size: fetched.buffer.length };
  } catch {
    return null; // media is best-effort; the TEXT part still routes
  }
}

// ── Intent classification (§25) — rules first; AI only ever classifies ───────

export function classifyIntent(text: string): "HELP" | "COMPLAINT" | "SERVICE" | "STATUS" | "INVOICE" | "HUMAN" | "CONTACT" | "UNKNOWN" {
  const t = text.trim().toUpperCase();
  if (!t) return "UNKNOWN";
  if (/^(HELP|MENU|HI|HELLO|START)\b/.test(t)) return "HELP";
  if (/^(AGENT|HUMAN|SUPPORT|OPERATOR|TALK TO (AGENT|SUPPORT|HUMAN))\b/.test(t)) return "HUMAN";
  if (/^(SERVICE|REQUEST SERVICE|BOOKING|APPOINTMENT)\b/.test(t)) return "SERVICE";
  if (/^(STATUS|COMPLAINT STATUS|WORK ORDER STATUS|TRACK)\b/.test(t)) return "STATUS";
  if (/^(INVOICE|BILL|STATEMENT|PAYMENT)\b/.test(t)) return "INVOICE";
  if (/^(COMPLAINT|COMPLAIN)\b/.test(t)) return "COMPLAINT";
  if (/^(CONTACT|HOURS|LOCATION|OFFICE)\b/.test(t)) return "CONTACT";
  // Natural-language free text (e.g. "AC not cooling") — the desired
  // automation (§22): a known customer describing a problem wants service.
  if (t.length >= 8 && text.trim().split(/\s+/).length >= 3) return "COMPLAINT";
  return "UNKNOWN";
}

async function routeIntent(intent: string, rawText: string, ctx: ReplyCtx): Promise<void> {
  switch (intent) {
    case "HELP":
    case "CONTACT":
    case "UNKNOWN":
      await autoReply(ctx, "WA_HELP", {});
      return;
    case "HUMAN":
      await handoffToHuman(ctx);
      return;
    case "SERVICE":
    case "COMPLAINT":
      await handleServiceRequest(ctx, rawText);
      return;
    case "STATUS":
      await handleStatusQuery(ctx);
      return;
    case "INVOICE":
      await handleInvoiceQuery(ctx);
      return;
  }
}

type ReplyCtx = { chatId: string; customerId: string | null; contactName: string };

async function autoReply(ctx: ReplyCtx, templateKey: string, extra: Record<string, string>, related?: { type: string; id: string }): Promise<void> {
  const template = await loadTemplateByKey(templateKey);
  if (!template) return;
  const { getBranding } = await import("@/lib/hms/pdf/branding");
  const brand = await getBranding().catch(() => null);
  const customer = ctx.customerId ? await db.customer.findUnique({ where: { id: ctx.customerId }, select: { contactPerson: true } }) : null;
  const data = {
    COMPANY_NAME: brand?.company || "MOHD.HMS Enterprise",
    CUSTOMER_NAME: customer?.contactPerson || ctx.contactName || "there",
    ...extra,
  };
  await queueDirect({
    templateKey, toChatId: ctx.chatId, category: "SUPPORT",
    data, relatedType: related?.type, relatedId: related?.id,
  });
}

// ── Intent implementations ───────────────────────────────────────────────────

async function handoffToHuman(ctx: ReplyCtx): Promise<void> {
  await db.whatsAppConversation.updateMany({ where: { chatId: ctx.chatId }, data: { state: "HUMAN" } });
  await autoReply(ctx, "WA_HUMAN_HANDOFF", {});
  await notifyRole("SUPERVISOR", {
    title: "WhatsApp support request",
    message: `A customer asked for human support on WhatsApp (${ctx.chatId}). Reply from the WhatsApp Inbox.`,
    type: "WARNING", resourceType: "WHATSAPP_CONVERSATION", resourceId: ctx.chatId,
  }).catch(() => undefined);
  await notifyRole("ADMIN", {
    title: "WhatsApp support request",
    message: `A customer asked for human support on WhatsApp (${ctx.chatId}).`,
    type: "WARNING", resourceType: "WHATSAPP_CONVERSATION", resourceId: ctx.chatId,
  }).catch(() => undefined);
  await audit({ action: "WHATSAPP_HUMAN_HANDOFF", resourceType: "WHATSAPP_CONVERSATION", resourceId: ctx.chatId, metadata: { chatId: ctx.chatId } }).catch(() => undefined);
}

/**
 * §59/§60 — service request via WhatsApp applies EXACTLY the portal rules:
 * customer identified (no invented identity §22/§23), profile complete =
 * mobile + address (company name OPTIONAL). Same backend outcome as the web
 * portal: complaint row + COMPLAINT_CREATED event + supervisor/admin notify.
 */
async function handleServiceRequest(ctx: ReplyCtx, text: string): Promise<void> {
  if (!ctx.customerId) {
    await autoReply(ctx, "WA_UNKNOWN_CONTACT", {});
    return;
  }
  const customer = await db.customer.findUnique({ where: { id: ctx.customerId } });
  if (!customer) {
    await autoReply(ctx, "WA_UNKNOWN_CONTACT", {});
    return;
  }
  const missing = missingCustomerFields(customer);
  if (missing.length) {
    await autoReply(ctx, "WA_PROFILE_INCOMPLETE", {});
    return;
  }

  const description = text.replace(/^(SERVICE|REQUEST SERVICE|COMPLAINT|COMPLAIN)\b[:\-\s]*/i, "").trim() || "Service request received via WhatsApp";
  const title = (description.length > 80 ? `${description.slice(0, 77)}...` : description);
  const code = await nextNumber("CPT");
  const systemUser = await db.user.findFirst({ where: { role: "SUPER_ADMIN", status: "ACTIVE" }, select: { id: true } });
  const actorId = systemUser?.id ?? "";

  const created = await db.complaint.create({
    data: {
      code, customerId: customer.id,
      title: `WhatsApp: ${title}`,
      description,
      priority: "MEDIUM",
      status: "NEW",
      createdById: actorId,
      statusHistory: { create: { fromStatus: "NEW", toStatus: "NEW", changedById: actorId, note: "Complaint created via WhatsApp" } },
    },
    select: { id: true, code: true },
  });

  await audit({
    action: "WHATSAPP_COMPLAINT_CREATED", resourceType: "COMPLAINT", resourceId: created.id,
    metadata: { code, chatId: ctx.chatId, customerId: customer.id, channel: "WHATSAPP" },
  }).catch(() => undefined);
  await notifyRole("SUPERVISOR", { title: "New complaint (WhatsApp)", message: `New complaint ${code} received via WhatsApp.`, type: "INFO", resourceType: "COMPLAINT", resourceId: created.id }).catch(() => undefined);
  await notifyRole("ADMIN", { title: "New complaint (WhatsApp)", message: `New complaint ${code} received via WhatsApp.`, type: "INFO", resourceType: "COMPLAINT", resourceId: created.id }).catch(() => undefined);
  await emit({ type: EVENT_TYPES.COMPLAINT_CREATED, resourceType: "COMPLAINT", resourceId: created.id, payload: { code, priority: "MEDIUM", customerId: customer.id, channel: "WHATSAPP" }, actorType: "SYSTEM" }).catch(() => undefined);

  // Confirmation flows through the COMPLAINT_CREATED automation (template
  // COMPLAINT_CREATED); if the automation is disabled, reply directly so the
  // customer always gets their complaint number (§22).
  const { isAutomationEnabled } = await import("@/lib/hms/workflows/settings");
  if (!(await isAutomationEnabled("whatsapp_notifications").catch(() => false))) {
    await autoReply(ctx, "WA_HELP", {}, { type: "COMPLAINT", id: created.id });
  }
  const template = await loadTemplateByKey("COMPLAINT_CREATED");
  if (template) {
    const { getBranding } = await import("@/lib/hms/pdf/branding");
    const brand = await getBranding().catch(() => null);
    await queueDirect({
      templateKey: "COMPLAINT_CREATED",
      toChatId: ctx.chatId,
      category: "COMPLAINT",
      data: {
        CUSTOMER_NAME: customer.contactPerson,
        COMPLAINT_NUMBER: created.code,
        COMPLAINT_TITLE: title,
        COMPANY_NAME: brand?.company || "MOHD.HMS Enterprise",
      },
      relatedType: "COMPLAINT",
      relatedId: created.id,
    });
    void template.version;
  }
  void extractVariables;
}

async function handleStatusQuery(ctx: ReplyCtx): Promise<void> {
  if (!ctx.customerId) {
    await autoReply(ctx, "WA_UNKNOWN_CONTACT", {});
    return;
  }
  const [complaints, workOrders] = await Promise.all([
    db.complaint.findMany({ where: { customerId: ctx.customerId }, orderBy: { createdAt: "desc" }, take: 3, select: { code: true, status: true, title: true } }),
    db.workOrder.findMany({ where: { customerId: ctx.customerId }, orderBy: { createdAt: "desc" }, take: 3, select: { code: true, status: true, title: true } }),
  ]);
  const lines: string[] = [];
  for (const c of complaints) lines.push(`Complaint ${c.code}: ${c.status}`);
  for (const w of workOrders) lines.push(`Work order ${w.code}: ${w.status}`);
  await autoReply(ctx, "WA_STATUS_REPLY", { STATUS_SUMMARY: lines.length ? lines.join("\n") : "You have no recent complaints or work orders." });
}

async function handleInvoiceQuery(ctx: ReplyCtx): Promise<void> {
  if (!ctx.customerId) {
    await autoReply(ctx, "WA_UNKNOWN_CONTACT", {});
    return;
  }
  const invoices = await db.invoice.findMany({
    where: { customerId: ctx.customerId },
    orderBy: { createdAt: "desc" }, take: 3,
    select: { code: true, status: true, totalCents: true, dueDate: true },
  });
  const lines = invoices.map((i) => `Invoice ${i.code}: ${i.status} — ${formatCurrency(i.totalCents / 100)} (due ${i.dueDate ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: LOCALIZATION.timezone }).format(i.dueDate) : "n/a"})`);
  await autoReply(ctx, "WA_INVOICE_REPLY", { INVOICE_SUMMARY: lines.length ? lines.join("\n") : "You have no invoices on file." });
}
