// MOHD.HMS ENTERPRISE — WhatsAppService (§12): THE single centralized backend
// service every module uses for WhatsApp. No module ever calls OpenWA
// directly (§53). Responsibilities: session status/connect/disconnect/reconnect,
// queue + send text/media/document, webhook registration, message status,
// retry, health, rate limiting. Business workflows live in automations.ts /
// inbound.ts; this file is transport + delivery state machine.

import crypto from "crypto";
import { db } from "@/lib/db";
import { emit } from "@/lib/hms/workflows/bus";
import { renderTemplate, loadTemplateByKey, extractVariables } from "./templates";
import { resolveAttachments, type ResolvedAttachment } from "./attachments";
import { normalizePhone, chatIdFromE164 } from "./normalize";
import { getGatewayClientConfig, getWebhookSecret, getWhatsAppConfig, recordTraffic, recordSessionStatus, recordWebhookRegistration } from "./config";
import * as openwa from "./openwa";
import type { WhatsAppErrorClass, WhatsAppAttachmentKind, WhatsAppRecipientRule } from "./types";

const MAX_PAYLOAD_CHARS = 4000; // WhatsApp text bodies are short; protect the DB row too

// ── Queue a direct send (staff replies, notifications, auto-replies) ────────

export type QueueDirectInput = {
  templateKey: string;
  toPhone?: string;          // raw phone (any supported format) — normalized here
  toChatId?: string;         // OR an already-known OpenWA chat id
  toContactId?: string;      // OR an existing WhatsAppContact id
  category: string;
  data: Record<string, string>;
  relatedType?: string;
  relatedId?: string;
  eventId?: string;
  automationId?: string;
  isTest?: boolean;
  critical?: boolean;
  attachments?: WhatsAppAttachmentKind[];
};

export type QueueResult = { ok: boolean; id?: string; reason?: string };

export async function queueDirect(input: QueueDirectInput): Promise<QueueResult> {
  const cfg = await getWhatsAppConfig();
  if (!cfg.enabled && !input.isTest) return { ok: false, reason: "WhatsApp integration is disabled" };

  // Resolve recipient → canonical chat id + contact row.
  const target = await resolveTarget(input);
  if (!target.ok) return { ok: false, reason: target.reason };

  // Template render — server-side, allowlisted variables only (§37/§69).
  const template = await loadTemplateByKey(input.templateKey);
  if (!template) return { ok: false, reason: `Unknown template ${input.templateKey}` };
  const body = renderTemplate(template.body, input.data ?? {}, extractVariables(template.body)).slice(0, MAX_PAYLOAD_CHARS);
  if (!body.trim() && !(input.attachments?.length)) return { ok: false, reason: "Rendered message is empty" };

  // Attachments via the central PDF engine / MinIO (§31) — resolved at send
  // time by the worker; only the requested kinds are recorded here.
  const attachmentKinds = input.attachments ?? [];

  const msg = await db.whatsAppMessage.create({
    data: {
      chatId: target.chatId,
      contactId: target.contactId,
      conversationId: target.conversationId,
      direction: "OUTBOUND",
      status: "QUEUED",
      type: attachmentKinds.length ? "document" : "text",
      body,
      templateKey: template.key,
      templateVersion: template.version,
      eventId: input.eventId ?? "",
      automationId: input.automationId ?? null,
      relatedType: input.relatedType ?? "",
      relatedId: input.relatedId ?? "",
      maxAttempts: input.critical ? 5 : 3,
      isTest: !!input.isTest,
      // Attachment kinds ride in mediaFilename as JSON until send time.
      mediaFilename: attachmentKinds.length ? JSON.stringify(attachmentKinds) : "",
      // Placeholder provider id: the unique [chatId, providerMessageId, direction]
      // anchor needs a DISTINCT value per queued message until the gateway
      // assigns the real id at send time.
      providerMessageId: `pending-${crypto.randomUUID()}`,
    },
  });

  void recordTraffic("outbound").catch(() => undefined);
  return { ok: true, id: msg.id };
}

type ResolvedTarget =
  | { ok: true; chatId: string; contactId: string | null; conversationId: string | null }
  | { ok: false; reason: string };

async function resolveTarget(input: QueueDirectInput): Promise<ResolvedTarget> {
  if (input.toContactId) {
    const contact = await db.whatsAppContact.findUnique({ where: { id: input.toContactId } });
    if (!contact) return { ok: false, reason: "Contact not found" };
    const conv = await ensureConversation(contact.chatId, contact.id, contact.customerId);
    return { ok: true, chatId: contact.chatId, contactId: contact.id, conversationId: conv.id };
  }
  let e164 = "";
  let chatId = "";
  if (input.toChatId && /@c\.us$/i.test(input.toChatId)) {
    chatId = input.toChatId.toLowerCase();
    e164 = chatId.replace(/@c\.us$/, "");
  } else if (input.toPhone) {
    const n = normalizePhone(input.toPhone);
    if (!n.ok) return { ok: false, reason: n.reason };
    e164 = n.e164;
    chatId = n.chatId;
  } else {
    return { ok: false, reason: "No recipient phone/chat id provided" };
  }
  const contact = await ensureContact(chatId, e164);
  const conv = await ensureConversation(chatId, contact.id, contact.customerId);
  return { ok: true, chatId, contactId: contact.id, conversationId: conv.id };
}

/** Find-or-create the WhatsAppContact for a canonical chat id (§15 — no duplicates). */
export async function ensureContact(chatId: string, e164?: string, waName?: string) {
  const existing = await db.whatsAppContact.findUnique({ where: { chatId } });
  const identity = e164 ? await resolveBusinessIdentity(e164) : { customerId: null, userId: null };
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (waName && !existing.waName) patch.waName = waName;
    if (identity.customerId && existing.customerId !== identity.customerId) {
      patch.customerId = identity.customerId;
      patch.kind = "CUSTOMER";
    } else if (identity.userId && existing.userId !== identity.userId) {
      patch.userId = identity.userId;
      patch.kind = "STAFF";
    }
    if (Object.keys(patch).length) {
      return db.whatsAppContact.update({ where: { id: existing.id }, data: patch });
    }
    return existing;
  }
  return db.whatsAppContact.create({
    data: {
      chatId, phone: e164 ?? phoneFromChat(chatId), waName: waName ?? "",
      customerId: identity.customerId, userId: identity.userId,
      kind: identity.customerId ? "CUSTOMER" : identity.userId ? "STAFF" : "CUSTOMER",
    },
  });
}

function phoneFromChat(chatId: string): string {
  const digits = chatId.replace(/@c\.us$/i, "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/** Per-process identity cache (e164 → business identity), 60s TTL. */
const gIdCache = (globalThis as unknown as { __hmsWaIdCache?: Map<string, { at: number; id: { customerId: string | null; userId: string | null } | null }> }).__hmsWaIdCache ??= new Map();

/**
 * Identify the business contact behind a canonical phone (§15/§16/§22):
 * CUSTOMER by Customer.phone, STAFF by User.phone (non-customer roles).
 * Stored customer/user phone formats are normalized on the fly — the cache
 * keeps this cheap. Never invents an identity: no match ⇒ null.
 */
export async function resolveBusinessIdentity(e164: string): Promise<{ customerId: string | null; userId: string | null }> {
  const cache = gIdCache!;
  const hit = cache.get(e164);
  if (hit && Date.now() - hit.at < 60_000) return hit.id ?? { customerId: null, userId: null };

  let found: { customerId: string | null; userId: string | null } | null = null;
  const customers = await db.customer.findMany({ where: { phone: { not: "" } }, select: { id: true, phone: true } });
  for (const c of customers) {
    const n = normalizePhone(c.phone);
    if (n.ok && n.e164 === e164) { found = { customerId: c.id, userId: null }; break; }
  }
  if (!found) {
    const users = await db.user.findMany({ where: { phone: { not: null }, role: { not: "CUSTOMER" } }, select: { id: true, phone: true } });
    for (const u of users) {
      if (!u.phone) continue;
      const n = normalizePhone(u.phone);
      if (n.ok && n.e164 === e164) { found = { customerId: null, userId: u.id }; break; }
    }
  }
  cache.set(e164, { at: Date.now(), id: found });
  return found ?? { customerId: null, userId: null };
}

export async function ensureConversation(chatId: string, contactId?: string | null, customerId?: string | null) {
  const existing = await db.whatsAppConversation.findUnique({ where: { chatId } });
  if (existing) return existing;
  return db.whatsAppConversation.create({ data: { chatId, contactId: contactId ?? null, customerId: customerId ?? null } });
}

// ── Delivery worker (§29/§49/§50) — the ONE outbound loop ───────────────────

const g = globalThis as unknown as { __hmsWaWorkerRunning?: boolean };

export async function tickWhatsAppWorker(): Promise<number> {
  if (g.__hmsWaWorkerRunning) return 0;
  g.__hmsWaWorkerRunning = true;
  try {
    const now = new Date();
    const due = await db.whatsAppMessage.findMany({
      where: { status: "QUEUED", scheduledAt: { lte: now } },
      orderBy: { scheduledAt: "asc" },
      take: 10,
      select: { id: true },
    });
    let sent = 0;
    for (const m of due) {
      const claimed = await db.whatsAppMessage.updateMany({
        where: { id: m.id, status: "QUEUED" },
        data: { status: "SENDING", attemptCount: { increment: 1 } },
      });
      if (claimed.count !== 1) continue;
      try {
        await sendOne(m.id);
        sent += 1;
      } catch {
        // sendOne owns failure transitions; never bubble into the loop.
      }
    }
    return sent;
  } finally {
    g.__hmsWaWorkerRunning = false;
  }
}

type AttachmentBundle = { attachments: ResolvedAttachment[]; kinds: WhatsAppAttachmentKind[] };

async function sendOne(messageId: string): Promise<void> {
  const gw = await getGatewayClientConfig();
  const msg = await db.whatsAppMessage.findUnique({ where: { id: messageId } });
  if (!msg) return;

  const fail = async (errorClass: WhatsAppErrorClass, error: string, permanent: boolean) => {
    const exhausted = msg.attemptCount >= msg.maxAttempts;
    if (permanent || exhausted) {
      await db.whatsAppMessage.update({
        where: { id: msg.id },
        data: { status: "FAILED", failedAt: new Date(), lastError: error.slice(0, 500), errorClass },
      });
      if (msg.automationId) {
        await emit({ type: "WHATSAPP_MESSAGE_FAILED", resourceType: "WHATSAPP_MESSAGE", resourceId: msg.id, payload: { error }, actorType: "SYSTEM" }).catch(() => undefined);
      }
      return;
    }
    // Temporary failure — exponential backoff (30s * 2^(n-1)), max 15m.
    const delayMs = Math.min(30_000 * 2 ** (msg.attemptCount - 1), 15 * 60_000);
    await db.whatsAppMessage.update({
      where: { id: msg.id },
      data: { status: "QUEUED", scheduledAt: new Date(Date.now() + delayMs), lastError: error.slice(0, 500), errorClass },
    });
  };

  if (!gw) {
    await fail("CONFIG", "OpenWA gateway is not configured (missing base URL or API key)", true);
    return;
  }
  const cfg = await getWhatsAppConfig();
  if (!cfg.enabled) {
    await fail("CONFIG", "WhatsApp integration is disabled", true);
    return;
  }

  try {
    let attachments: AttachmentBundle = { attachments: [], kinds: [] };
    if (msg.mediaFilename && msg.mediaFilename.startsWith("[")) {
      try {
        const kinds = JSON.parse(msg.mediaFilename) as WhatsAppAttachmentKind[];
        const related = { resourceType: msg.relatedType || "INVOICE", resourceId: msg.relatedId };
        const res = await resolveAttachments(kinds, related);
        attachments = { attachments: res.attachments, kinds };
      } catch {
        attachments = { attachments: [], kinds: [] };
      }
    }

    const sessionId = await resolveSessionId(gw);
    if (!sessionId) {
      await fail("CONFIG", "WhatsApp session has not been created in the gateway yet", false);
      return;
    }
    let providerMessageId = "";
    if (attachments.attachments.length) {
      const doc = attachments.attachments[0]; // one document per WhatsApp message
      const res = await openwa.sendDocument(gw, sessionId, msg.chatId, {
        base64: doc.buffer.toString("base64"),
        mimetype: doc.contentType,
        filename: doc.filename,
        caption: msg.body || undefined,
      });
      providerMessageId = res.id ?? res.messageId ?? "";
    } else {
      const res = await openwa.sendText(gw, sessionId, msg.chatId, msg.body);
      providerMessageId = res.id ?? res.messageId ?? "";
    }

    await db.whatsAppMessage.update({
      where: { id: msg.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        lastError: "",
        errorClass: "",
        ...(providerMessageId ? { providerMessageId } : {}),
        type: attachments.attachments.length ? "document" : "text",
      },
    });
    await emit({ type: "WHATSAPP_MESSAGE_SENT", resourceType: "WHATSAPP_MESSAGE", resourceId: msg.id, payload: { chatId: msg.chatId }, actorType: "SYSTEM" }).catch(() => undefined);
  } catch (e) {
    const err = e as openwa.OpenWaError;
    const raw = err?.kind ?? "PROVIDER";
    const cls: WhatsAppErrorClass = raw === "AUTH" ? "AUTHENTICATION" : raw === "VALIDATION" ? "PERMANENT" : raw;
    const permanent = cls === "AUTHENTICATION" || cls === "PERMANENT";
    await fail(cls, err?.message ?? String(e), permanent);
  }
}

// ── Session lifecycle (§8/§9/§10/§34) ───────────────────────────────────────

/**
 * Resolve the configured session NAME to the gateway's real session id
 * (OpenWA addresses sessions by UUID; the name is MOHD.HMS's own handle).
 * Cached 60s per process; null when the session does not exist yet.
 */
const gSid = (globalThis as unknown as { __hmsWaSessionId?: { id: string | null; at: number } }).__hmsWaSessionId ??= { id: null, at: 0 };
export async function resolveSessionId(client: { baseUrl: string; apiKey: string; sessionName: string }): Promise<string | null> {
  if (gSid.id && Date.now() - gSid.at < 60_000) return gSid.id;
  try {
    const sessions = await openwa.listSessions(client);
    const mine = sessions.find((s) => s.name === client.sessionName);
    gSid.id = mine?.id ?? null;
    gSid.at = Date.now();
    return gSid.id;
  } catch {
    return null;
  }
}

function invalidateSessionIdCache(): void {
  gSid.id = null;
  gSid.at = 0;
}

/** Ensure the configured session exists in the gateway (create if missing) and start it.
 *  Idempotent (§16): an already-active session is REUSED, not restarted — the gateway
 *  refuses a duplicate start with 400 "Session is already started", and stamping
 *  `initializing` over a live qr_ready/ready session would fake-flap the status. */
const GATEWAY_ACTIVE_STATUSES = ["initializing", "qr_ready", "authenticating", "ready"];

export async function connectSession(): Promise<{ ok: boolean; detail: string; qrRequired?: boolean }> {
  const gw = await getGatewayClientConfig();
  if (!gw) return { ok: false, detail: "OpenWA gateway URL or API key is not configured" };
  try {
    const sessions = await openwa.listSessions(gw);
    let session = sessions.find((s) => s.name === gw.sessionName);
    if (!session) session = await openwa.createSession(gw, gw.sessionName);
    const id = session.id ?? gw.sessionName;
    gSid.id = id; gSid.at = Date.now();
    if (!GATEWAY_ACTIVE_STATUSES.includes(session.status ?? "")) {
      // Genuinely down (created/disconnected/failed) — bring the engine up.
      await recordSessionStatus({ status: "initializing", error: "" });
      try {
        await openwa.startSession(gw, id);
      } catch (e) {
        // Race: another caller (or the gateway's own reconnect loop) started
        // it between the list and the start — an active session is success.
        if (!/already started/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
    }
    await syncSessionStatus(gw, id);
    return { ok: true, detail: `Session ${gw.sessionName} started`, qrRequired: true };
  } catch (e) {
    const err = e as openwa.OpenWaError;
    await recordSessionStatus({ status: "failed", error: err.message });
    return { ok: false, detail: err.message };
  }
}

/** Pull the REAL session status from the gateway and mirror it honestly (§34/§48). */
export async function syncSessionStatus(gw?: { baseUrl: string; apiKey: string; sessionName: string }, sessionId?: string): Promise<{ status: string; phone: string; detail: string }> {
  const client = gw ?? await getGatewayClientConfig();
  if (!client) {
    await recordSessionStatus({ status: "unknown", error: "Gateway not configured" });
    return { status: "unknown", phone: "", detail: "Gateway not configured" };
  }
  const id = sessionId ?? await resolveSessionId(client);
  if (!id) {
    await recordSessionStatus({ status: "disconnected", error: "Session has not been created in the gateway yet" });
    return { status: "disconnected", phone: "", detail: "not created" };
  }
  try {
    const s = await openwa.getSession(client, id);
    await recordSessionStatus({ status: s.status ?? "unknown", phone: s.phone ?? null, pushName: s.pushName ?? null, error: s.lastError ?? null });
    if (s.status === "ready") await ensureWebhook(client, id);
    return { status: s.status ?? "unknown", phone: s.phone ?? "", detail: "ok" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if ((e as openwa.OpenWaError)?.status === 404) {
      await recordSessionStatus({ status: "disconnected", error: "Session does not exist in the gateway" });
      return { status: "disconnected", phone: "", detail: msg };
    }
    await recordSessionStatus({ error: msg });
    return { status: "unknown", phone: "", detail: msg };
  }
}

export type SessionQrState = "WAITING" | "UNAVAILABLE";
export type SessionQrResult = { ok: boolean; qr?: string; detail: string; state?: SessionQrState };

/**
 * Current QR (PNG data URL) — ONLY while the engine is genuinely in qr_ready.
 *
 * WHY THE STATUS GUARD MATTERS ("No device found" root cause): the OpenWA
 * engine caches the LAST rendered QR through transient socket drops — during
 * the reconnect backoff (status `initializing`, up to 60s+ per attempt) the
 * gateway keeps answering /qr with that stale PNG. A QR ref is bound to the
 * live socket that registered the pairing intent; once that socket closes the
 * ref is unpairable and WhatsApp mobile answers a scan with "No device
 * found". Serving a QR whose engine status is anything other than qr_ready
 * therefore hands the user a guaranteed-dead code. The guard turns that into
 * an honest "re-establishing" state so the UI shows the real pairing state.
 */
export async function getSessionQrDataUrl(): Promise<SessionQrResult> {
  const gw = await getGatewayClientConfig();
  if (!gw) return { ok: false, detail: "OpenWA gateway is not configured", state: "UNAVAILABLE" };
  try {
    const sessionId = await resolveSessionId(gw);
    if (!sessionId) return { ok: false, detail: "Session has not been created in the gateway yet", state: "UNAVAILABLE" };
    const live = await syncSessionStatus(gw, sessionId);
    const res = await openwa.getSessionQr(gw, sessionId);
    // Freshness gate: a pairable QR exists only while the engine sits in
    // qr_ready on a live socket. Any other status (initializing during the
    // reconnect backoff, authenticating after a scan, disconnected, …) means
    // whatever QR the gateway still caches is dead. If the gateway omits the
    // status field (older contract) fall back to the live status we just
    // synced above.
    const engineStatus = res.status ?? live.status;
    if (engineStatus && engineStatus !== "qr_ready") {
      return engineStatus === "initializing" || engineStatus === "created"
        ? { ok: false, detail: "Pairing socket is re-establishing — a fresh QR appears automatically in a few seconds.", state: "WAITING" }
        : { ok: false, detail: `No QR available right now (session is ${engineStatus})`, state: "UNAVAILABLE" };
    }
    if (!res.qrCode) return { ok: false, detail: "No QR available — the session may already be linked; reconnect to generate a fresh pairing.", state: "UNAVAILABLE" };
    return { ok: true, qr: res.qrCode, detail: "ok" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // First-QR race: the engine flips qr_ready a beat before the first QR is
    // rendered, so the gateway can answer 400 "QR code is not ready yet" —
    // a waiting state, not a failure.
    if (/not ready yet/i.test(msg)) {
      return { ok: false, detail: "The first QR is being generated — a fresh QR appears in a few seconds.", state: "WAITING" };
    }
    return { ok: false, detail: msg, state: "UNAVAILABLE" };
  }
}

export async function getSessionPairingCode(phone: string): Promise<{ ok: boolean; code?: string; detail: string }> {
  const gw = await getGatewayClientConfig();
  if (!gw) return { ok: false, detail: "OpenWA gateway is not configured" };
  const n = normalizePhone(phone);
  if (!n.ok) return { ok: false, detail: n.reason };
  try {
    const sessionId = await resolveSessionId(gw);
    if (!sessionId) return { ok: false, detail: "Session has not been created in the gateway yet" };
    // Sync first: a pairing code is only deliverable while the engine socket
    // is actually up (qr_ready / not-yet-authenticated). On a socket that has
    // begun closing the gateway's own request fails late with an opaque
    // engine error — asking on a known-dead state instead returns an honest,
    // actionable message (and QR_REQUIRED tells the user to just scan).
    const live = await syncSessionStatus(gw, sessionId);
    if (live.status === "ready") return { ok: false, detail: "Session is already linked — no pairing needed." };
    if (live.status && !["qr_ready", "initializing", "created"].includes(live.status)) {
      return { ok: false, detail: `Pairing is not available while the session is ${live.status}. Reconnect first.` };
    }
    const res = await openwa.requestPairingCode(gw, sessionId, n.e164.replace("+", ""));
    if (!res.pairingCode) return { ok: false, detail: "Gateway did not return a pairing code" };
    return { ok: true, code: res.pairingCode, detail: "ok" };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Baileys refuses pairing codes on a socket that has begun closing ("qr_ready
    // is necessary but not sufficient" — see the gateway's own API docs). Map the
    // engine refusal to the recovery action instead of a dead-end error.
    if (/closing|closed|restart|not connected|connection/i.test(raw)) {
      return { ok: false, detail: "The pairing socket is re-establishing — press Refresh pairing (or wait a few seconds) and request the code again." };
    }
    return { ok: false, detail: raw };
  }
}

export async function disconnectSession(logout: boolean): Promise<{ ok: boolean; detail: string }> {
  const gw = await getGatewayClientConfig();
  if (!gw) return { ok: false, detail: "OpenWA gateway is not configured" };
  try {
    const sessionId = await resolveSessionId(gw);
    if (sessionId) {
      if (logout) await openwa.logoutSession(gw, sessionId);
      else await openwa.stopSession(gw, sessionId);
      invalidateSessionIdCache();
    }
    await recordSessionStatus({ status: "disconnected", phone: null, error: "" });
    return { ok: true, detail: logout ? "Session logged out (re-authentication required)" : "Session stopped" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordSessionStatus({ error: msg });
    return { ok: false, detail: msg };
  }
}

/** Register/refresh the MOHD.HMS webhook on the session with a signing secret (§17/§18). */
const WEBHOOK_EVENTS = [
  "message.received", "message.sent", "message.ack", "message.failed",
  "session.status", "session.qr", "session.authenticated", "session.disconnected",
];

export async function ensureWebhook(client?: { baseUrl: string; apiKey: string; sessionName: string }, sessionId?: string): Promise<{ ok: boolean; detail: string }> {
  const gw = client ?? await getGatewayClientConfig();
  if (!gw) return { ok: false, detail: "OpenWA gateway is not configured" };
  const secret = await getWebhookSecret();
  if (!secret) return { ok: false, detail: "Webhook signing secret is not configured" };

  // The webhook target is THIS app (server-side loopback in the sandbox;
  // the deployment origin in production). OpenWA's SSRF guard must allow it.
  const selfOrigin = process.env.WA_WEBHOOK_ORIGIN || process.env.APP_ORIGIN || "http://127.0.0.1:3000";
  const webhookUrl = `${selfOrigin.replace(/\/$/, "")}/api/v1/whatsapp/openwa/webhook`;

  try {
    const id = sessionId ?? await resolveSessionId(gw);
    if (!id) return { ok: false, detail: "Session has not been created in the gateway yet" };
    const existing = await openwa.listWebhooks(gw, id);
    const mine = existing.find((w) => (w.url || "") === webhookUrl);
    if (mine?.id) {
      await recordWebhookRegistration(mine.id);
      return { ok: true, detail: "Webhook already registered" };
    }
    const created = await openwa.createWebhook(gw, id, { url: webhookUrl, events: WEBHOOK_EVENTS, secret });
    await recordWebhookRegistration(created.id ?? "");
    return { ok: true, detail: "Webhook registered" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Test message (§35) ───────────────────────────────────────────────────────

export async function sendTestMessage(toPhone: string, text: string, actorId: string, actorEmail: string): Promise<{ ok: boolean; detail: string; messageId?: string }> {
  const res = await queueDirect({
    templateKey: "GENERAL_NOTIFICATION",
    toPhone,
    category: "SYSTEM",
    isTest: true,
    data: { NOTIFICATION_TITLE: "MOHD.HMS test message", NOTIFICATION_MESSAGE: text || "This is a MOHD.HMS WhatsApp test message.", USER_NAME: actorEmail },
  });
  if (!res.ok) return { ok: false, detail: res.reason ?? "Queue failed" };
  // Drain it immediately for honest test feedback (worker also picks it up).
  await db.whatsAppMessage.update({ where: { id: res.id! }, data: { scheduledAt: new Date(Date.now() - 1000) } });
  const cfg = await getWhatsAppConfig();
  try {
    if (cfg.enabled) await tickWhatsAppWorker();
    const after = await db.whatsAppMessage.findUnique({ where: { id: res.id! }, select: { status: true, lastError: true } });
    if (after?.status === "SENT") return { ok: true, detail: "Test message sent", messageId: res.id };
    if (after?.status === "QUEUED" || after?.status === "SENDING") {
      return { ok: true, detail: "Test message queued (gateway busy; watch the log)", messageId: res.id };
    }
    return { ok: false, detail: after?.lastError || `Test message status: ${after?.status}`, messageId: res.id };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), messageId: res.id };
  }
}

// ── Health (§48) — honest values only ───────────────────────────────────────

export async function whatsappHealth() {
  const cfg = await getWhatsAppConfig();
  const gw = await getGatewayClientConfig();
  const [reachable, queueCounts, lastInbound, lastOutbound] = await Promise.all([
    gw ? openwa.gatewayHealth(gw) : Promise.resolve({ ok: false, detail: "not configured" }),
    db.whatsAppMessage.groupBy({ by: ["status"], _count: { _all: true } }),
    db.whatsAppMessage.findFirst({ where: { direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.whatsAppMessage.findFirst({ where: { direction: "OUTBOUND", status: { in: ["SENT", "DELIVERED", "READ"] } }, orderBy: { sentAt: "desc" }, select: { sentAt: true } }),
  ]);

  let apiKeyValid = false;
  if (gw && reachable.ok) {
    const v = await openwa.validateApiKey(gw);
    apiKeyValid = v.ok;
  }

  const byStatus: Record<string, number> = {};
  for (const row of queueCounts) byStatus[row.status] = row._count._all;

  return {
    configOk: !!gw && cfg.enabled,
    gateway: { reachable: reachable.ok, detail: reachable.detail },
    apiKeyValid,
    session: {
      status: cfg.sessionStatus,
      phone: cfg.sessionPhone,
      connected: cfg.sessionStatus === "ready",
      lastHeartbeatAt: cfg.lastHeartbeatAt?.toISOString() ?? null,
      lastConnectedAt: cfg.lastConnectedAt?.toISOString() ?? null,
    },
    webhook: { registered: cfg.webhookRegistered },
    queue: {
      queued: byStatus["QUEUED"] ?? 0,
      sending: byStatus["SENDING"] ?? 0,
      sent: byStatus["SENT"] ?? 0,
      delivered: byStatus["DELIVERED"] ?? 0,
      read: byStatus["READ"] ?? 0,
      failed: byStatus["FAILED"] ?? 0,
    },
    lastInboundAt: lastInbound?.createdAt.toISOString() ?? null,
    lastOutboundAt: lastOutbound?.sentAt?.toISOString() ?? null,
  };
}

// ── Retry / cancel (§50) ─────────────────────────────────────────────────────

export async function retryMessage(id: string): Promise<{ ok: boolean; reason?: string }> {
  const msg = await db.whatsAppMessage.findUnique({ where: { id } });
  if (!msg) return { ok: false, reason: "Message not found" };
  if (msg.direction !== "OUTBOUND") return { ok: false, reason: "Only outbound messages can be retried" };
  if (msg.status === "SENT" || msg.status === "DELIVERED" || msg.status === "READ") return { ok: false, reason: "Message was already delivered" };
  await db.whatsAppMessage.update({
    where: { id },
    data: { status: "QUEUED", scheduledAt: new Date(Date.now() - 1000), attemptCount: 0, lastError: "", errorClass: "" },
  });
  return { ok: true };
}

export async function cancelMessage(id: string): Promise<{ ok: boolean; reason?: string }> {
  const msg = await db.whatsAppMessage.findUnique({ where: { id } });
  if (!msg) return { ok: false, reason: "Message not found" };
  if (!["QUEUED", "SENDING", "FAILED"].includes(msg.status)) return { ok: false, reason: `Cannot cancel a ${msg.status} message` };
  await db.whatsAppMessage.update({ where: { id }, data: { status: "CANCELED" } });
  return { ok: true };
}

// ── Recipient rule resolution (shared with automations) ─────────────────────

export async function resolveRecipients(rule: WhatsAppRecipientRule, ctx: { customerId?: string | null; userId?: string | null; relatedType?: string; relatedId?: string }): Promise<{ phones: string[]; skipped: string[] }> {
  const phones: string[] = [];
  const skipped: string[] = [];
  if (rule.kind === "FIXED") {
    const n = normalizePhone(rule.value);
    if (n.ok) phones.push(n.e164);
    else skipped.push(`FIXED: ${n.reason}`);
    return { phones, skipped };
  }
  if (rule.kind === "ROLE") {
    const users = await db.user.findMany({
      where: { role: rule.value, status: "ACTIVE", phone: { not: null } },
      select: { phone: true },
      take: 50,
    });
    for (const u of users) {
      const n = normalizePhone(u.phone);
      if (n.ok) phones.push(n.e164);
    }
    if (!phones.length) skipped.push(`ROLE ${rule.value}: no reachable WhatsApp numbers`);
    return { phones, skipped };
  }
  if (rule.kind === "CUSTOMER") {
    if (!ctx.customerId) {
      skipped.push("CUSTOMER: event has no customer");
      return { phones, skipped };
    }
    const customer = await db.customer.findUnique({ where: { id: ctx.customerId }, select: { phone: true, status: true } });
    const n = customer ? normalizePhone(customer.phone) : { ok: false as const, reason: "customer missing" };
    if (customer?.status !== "ACTIVE") skipped.push("CUSTOMER: not active");
    else if (!n.ok) skipped.push(`CUSTOMER: ${n.reason}`);
    else phones.push(n.e164);
    return { phones, skipped };
  }
  // RELATED_USER — the user tied to the event (technician, assignee…).
  if (!ctx.userId) {
    skipped.push("RELATED_USER: event has no user");
    return { phones, skipped };
  }
  const user = await db.user.findUnique({ where: { id: ctx.userId }, select: { phone: true } });
  const n = user ? normalizePhone(user.phone) : { ok: false as const, reason: "user missing" };
  if (!n.ok) skipped.push(`RELATED_USER: ${n.reason}`);
  else phones.push(n.e164);
  return { phones, skipped };
}

export { chatIdFromE164 };
