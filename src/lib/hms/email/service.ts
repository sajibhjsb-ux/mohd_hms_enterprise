// MOHD.HMS ENTERPRISE — EmailService (§6/§15/§16/§19/§20/§31–§37/§39/§53/§70).
// THE one centralized email service. Modules never implement SMTP logic —
// they either emit DomainEvents (automation emails) or call queueDirect/sendOtp.
//
//   BUSINESS EVENT → outbox commit → runEmailAutomations (workflow handler)
//     → automation rules → recipient engine → data resolution → template render
//     → EmailLog QUEUED (idempotent per event+automation)
//   → tickEmailWorker (existing scheduler loop, no second scheduler)
//     → attachment resolution (MinIO / central PDF engine) → SMTP provider
//     → SENT / retry-with-backoff / DEAD_LETTER → EmailLog (authoritative)

import "server-only";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { audit } from "@/lib/hms/services";
import { getAutomationSetting } from "@/lib/hms/workflows/settings";
import { emailOtpResendCooldownSec } from "@/lib/hms/email-otp";
import { EMAIL_OTP_TTL_SEC } from "@/lib/hms/email-otp";
import { getEmailConfig } from "./config";
import { resolveAttachments } from "./attachments";
import { resolveTemplateData, type ResolutionContext } from "./resolve";
import { renderTemplate } from "./render";
import { smtpProvider } from "./provider";
import type {
  AttachmentSpec, EmailCondition, RecipientRule, RenderedEmail, SenderIdentity,
} from "./types";

// ─── Public input types ─────────────────────────────────────────────────────

export type QueueDirectInput = {
  templateKey: string;
  to: string;
  toUserId?: string;
  cc?: string[];
  bcc?: string[];
  category: string;
  relatedType?: string;
  relatedId?: string;
  data: Record<string, string>;
  sender?: Partial<SenderIdentity>;
  isTest?: boolean;
  /** Critical emails (OTP) bypass the channel gate + user preferences (§40). */
  critical?: boolean;
};

export type QueueResult = { ok: boolean; id?: string; reason?: string };

// ─── Small helpers ──────────────────────────────────────────────────────────

const EMAIL_ADDR_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const isValidAddr = (a: string) => a.length <= 254 && EMAIL_ADDR_RE.test(a.trim());

function headerSafe(value: string): string {
  // Subject/recipient header injection guard (§38) — strip CR/LF entirely.
  return value.replace(/[\r\n]+/g, " ").trim();
}

async function senderFor(override?: Partial<SenderIdentity>): Promise<SenderIdentity> {
  const cfg = await getEmailConfig();
  return {
    fromName: override?.fromName || cfg.fromName || "MOHD.HMS Enterprise",
    fromEmail: override?.fromEmail || cfg.fromEmail || cfg.smtpUser || "",
    replyTo: override?.replyTo || cfg.replyTo || "",
  };
}

/** Honest gate (§70): the channel setting only blocks QUEUING of automation mail. */
async function emailChannelEnabled(): Promise<boolean> {
  return (await getAutomationSetting("email_notifications")) === "on";
}

// ─── 1. Direct queue (admin/test/OTP/system-initiated mail) ─────────────────

export async function queueDirect(input: QueueDirectInput): Promise<QueueResult> {
  const to = input.to.trim();
  if (!isValidAddr(to)) return { ok: false, reason: "invalid recipient" };
  const cc = (input.cc ?? []).map((a) => a.trim()).filter(Boolean);
  const bcc = (input.bcc ?? []).map((a) => a.trim()).filter(Boolean);
  if ([...cc, ...bcc].some((a) => !isValidAddr(a))) return { ok: false, reason: "invalid cc/bcc recipient" };

  const template = await db.emailTemplate.findUnique({ where: { key: input.templateKey } });
  if (!template || template.deletedAt || (!template.isActive && !input.critical)) {
    return { ok: false, reason: `template ${input.templateKey} unavailable` };
  }

  const ctx: ResolutionContext = { eventType: "DIRECT", resourceType: input.relatedType ?? "", resourceId: input.relatedId ?? "", payload: {}, user: input.toUserId ? await userBrief(input.toUserId) : null, extra: input.data };
  const data = await resolveTemplateData(template.key, ctx);
  const rendered = await renderTemplate({ subject: template.subject, bodyHtml: template.bodyHtml, data });
  const sender = await senderFor(input.sender);

  const row = await db.emailLog.create({
    data: {
      status: "QUEUED",
      eventId: "",
      automationId: null,
      templateKey: template.key,
      templateVersion: template.version,
      category: template.category || input.category,
      toEmail: to,
      toUserId: input.toUserId ?? "",
      cc: cc.join(", "),
      bcc: bcc.join(", "),
      replyTo: sender.replyTo,
      fromName: sender.fromName,
      fromEmail: sender.fromEmail,
      subject: headerSafe(rendered.subject).slice(0, 500),
      bodyHtml: rendered.html,
      relatedType: input.relatedType ?? "",
      relatedId: input.relatedId ?? "",
      maxAttempts: 3,
      attachmentRefs: "[]",
      isTest: input.isTest ?? false,
    },
  });
  return { ok: true, id: row.id };
}

async function userBrief(userId: string): Promise<{ id: string; email: string; name: string } | null> {
  return db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } });
}

// ─── 2. OTP email (§45 — auth calls EmailService, never SMTP directly) ──────

export async function sendOtpEmail(params: {
  user: { id: string; email: string; name?: string };
  purpose: "EMAIL_VERIFICATION" | "PASSWORD_RESET";
  code: string;
}): Promise<QueueResult> {
  const templateKey = params.purpose === "PASSWORD_RESET" ? "PASSWORD_RESET_OTP" : "EMAIL_VERIFICATION_OTP";
  return queueDirect({
    templateKey,
    to: params.user.email,
    toUserId: params.user.id,
    category: "AUTHENTICATION",
    critical: true, // security-critical — never gated, never opt-out (§40)
    data: {
      OTP_CODE: params.code,
      OTP_EXPIRY_MINUTES: String(Math.round(EMAIL_OTP_TTL_SEC / 60)),
      USER_NAME: params.user.name ?? "",
      USER_EMAIL: params.user.email,
      RESEND_COOLDOWN_SEC: String(emailOtpResendCooldownSec(params.purpose)),
    },
  });
}

// ─── 3. Letters (§49 — finalized HR letter delivered with its MinIO PDF) ────

export async function queueLetterEmail(params: {
  letterId: string;
  to: string;
  subject?: string;
  sender?: Partial<SenderIdentity>;
}): Promise<QueueResult> {
  if (!isValidAddr(params.to)) return { ok: false, reason: "invalid recipient" };
  const letter = await db.letter.findUnique({
    where: { id: params.letterId },
    select: { letterNumber: true, subject: true, letterDate: true, status: true, pdfObjectKey: true, finalizedAt: true },
  });
  if (!letter || letter.status !== "FINALIZED") return { ok: false, reason: "letter is not finalized" };
  const template = await db.emailTemplate.findUnique({ where: { key: "HR_LETTER_SENT" } });
  if (!template || !template.isActive) return { ok: false, reason: "letter template unavailable" };

  const rendered = await renderTemplate({
    subject: template.subject,
    bodyHtml: template.bodyHtml,
    data: {
      LETTER_NUMBER: letter.letterNumber,
      LETTER_DATE: letter.letterDate ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(letter.letterDate) : "",
      LETTER_SUBJECT: params.subject || letter.subject,
      LETTER_RECIPIENT: params.to,
    },
  });
  const sender = await senderFor(params.sender);
  const row = await db.emailLog.create({
    data: {
      status: "QUEUED",
      templateKey: template.key,
      templateVersion: template.version,
      category: "LETTERS",
      toEmail: params.to.trim(),
      replyTo: sender.replyTo,
      fromName: sender.fromName,
      fromEmail: sender.fromEmail,
      subject: headerSafe(rendered.subject).slice(0, 500),
      bodyHtml: rendered.html,
      relatedType: "LETTER",
      relatedId: params.letterId,
      maxAttempts: 3,
      attachmentRefs: JSON.stringify([{ kind: "LETTER_PDF", label: "Final letter PDF", filename: `${letter.letterNumber}.pdf` }]),
    },
  });
  return { ok: true, id: row.id };
}

// ─── 4. Automation engine — workflow handler for DomainEvents (§15/§16/§34) ─

export async function runEmailAutomations(ctx: {
  eventId: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
}): Promise<{ queued: number; skipped: string[] }> {
  const skipped: string[] = [];
  let queued = 0;

  // The channel gate (default "off") keeps the whole channel silent until an
  // admin enables email delivery — flipping it on activates every automation.
  if (!(await emailChannelEnabled())) {
    return { queued: 0, skipped: ["email channel disabled (settings)"] };
  }

  const automations = await db.emailAutomation.findMany({
    where: { eventType: ctx.eventType, enabled: true },
  });
  if (automations.length === 0) return { queued: 0, skipped: ["no automations for event"] };

  for (const automation of automations) {
    try {
      const result = await runOneAutomation(automation, ctx);
      if (result.queued) queued += result.queued;
      else skipped.push(result.reason ?? "skipped");
      if (result.skipped?.length) skipped.push(...result.skipped);
    } catch (e) {
      skipped.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { queued, skipped };
}

type AutomationWithTemplate = Awaited<ReturnType<typeof db.emailAutomation.findMany>>[number];

async function runOneAutomation(
  automation: AutomationWithTemplate,
  ctx: { eventId: string; eventType: string; resourceType: string; resourceId: string; payload: Record<string, unknown> }
): Promise<{ queued: number; reason?: string; skipped?: string[] }> {
  // ── Idempotency (§35): the unique [eventId, automationId] row IS the guard.
  // A duplicate event delivery can never create a second email.
  const existing = await db.emailLog.findFirst({
    where: { eventId: ctx.eventId, automationId: automation.id },
    select: { id: true },
  });
  if (existing) return { queued: 0, reason: "already queued for this event (idempotent)" };

  // ── Extra dedupe window for alert-style events (§35) ──
  if (automation.dedupeHours > 0) {
    const since = new Date(Date.now() - automation.dedupeHours * 3_600_000);
    const recent = await db.emailLog.findFirst({
      where: { automationId: automation.id, relatedId: ctx.resourceId, relatedType: ctx.resourceType, createdAt: { gte: since }, status: { notIn: ["CANCELED"] } },
      select: { id: true },
    });
    if (recent) return { queued: 0, reason: `deduped (${automation.dedupeHours}h window)` };
  }

  // The automation references its template by canonical key (no FK relation).
  const template = await db.emailTemplate.findUnique({ where: { key: automation.templateKey } });
  if (!template || template.deletedAt || !template.isActive) return { queued: 0, reason: `template ${automation.templateKey} inactive` };

  // ── Data resolution + conditions (§34 — evaluated server-side, controlled) ──
  const resolutionCtx: ResolutionContext = {
    eventType: ctx.eventType, resourceType: ctx.resourceType, resourceId: ctx.resourceId, payload: ctx.payload, user: null,
  };
  const data = await resolveTemplateData(automation.templateKey, resolutionCtx);

  const conditions = safeParse<EmailCondition[]>(automation.conditions, []);
  for (const cond of conditions) {
    if (!conditionMatches(cond, data, ctx.payload)) {
      return { queued: 0, reason: `condition not met: ${cond.field} ${cond.op} ${String(cond.value ?? "")}` };
    }
  }

  // ── Recipient engine (§23) ──
  const rule = safeParse<RecipientRule>(automation.recipientRule, { kind: "RELATED_USER" } as RecipientRule);
  const recipients = await resolveRecipients(rule, ctx);
  if (recipients.length === 0) return { queued: 0, reason: "no recipient resolved" };

  // ── Rate limit (§39 — one faulty automation can never flood mailboxes) ──
  const hourlyCap = Number((await getAutomationSetting("email_max_per_automation_hour")) || 60);
  const hourAgo = new Date(Date.now() - 3_600_000);
  const sentLastHour = await db.emailLog.count({ where: { automationId: automation.id, createdAt: { gte: hourAgo } } });
  if (sentLastHour >= hourlyCap) return { queued: 0, reason: `rate limited (max ${hourlyCap}/hour)` };

  // ── Render ONCE at queue time — the log stores the exact subject/body +
  //    template version used (§42 traceability), independent of later edits. ──
  const rendered = await renderTemplate({ subject: template.subject, bodyHtml: template.bodyHtml, data });
  const sender = await senderFor({
    fromName: automation.senderName || undefined,
    fromEmail: automation.senderEmail || undefined,
    replyTo: automation.replyTo || undefined,
  });

  const attachmentSpecs = safeParse<AttachmentSpec[]>(automation.attachments, []);
  const attachmentMeta = attachmentSpecs.map((s) => ({
    kind: s.kind,
    label: ATTACHMENT_LABELS[s.kind] ?? s.kind,
    filename: ATTACHMENT_DEFAULT_FILENAME[s.kind] ?? "attachment.pdf",
  }));

  let created = 0;
  const skipped: string[] = [];
  for (const to of recipients) {
    if (!isValidAddr(to)) { skipped.push(`invalid recipient ${to}`); continue; }
    try {
      await db.emailLog.create({
        data: {
          status: "QUEUED",
          eventId: ctx.eventId,
          automationId: automation.id,
          templateKey: template.key,
          templateVersion: template.version,
          category: template.category,
          toEmail: to,
          replyTo: sender.replyTo,
          fromName: sender.fromName,
          fromEmail: sender.fromEmail,
          subject: headerSafe(rendered.subject).slice(0, 500),
          bodyHtml: rendered.html,
          relatedType: ctx.resourceType,
          relatedId: ctx.resourceId,
          maxAttempts: automation.maxAttempts,
          scheduledAt: new Date(Date.now() + Math.max(0, automation.delayMinutes) * 60_000),
          attachmentRefs: JSON.stringify(attachmentMeta),
        },
      });
      created++;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        skipped.push("idempotent duplicate"); // unique [eventId, automationId] hit
      } else throw e;
    }
  }
  return { queued: created, reason: created === 0 ? "no emails created" : undefined, skipped: skipped.length ? skipped : undefined };
}

const ATTACHMENT_LABELS: Record<string, string> = {
  INVOICE_PDF: "Invoice PDF", QUOTATION_PDF: "Quotation PDF", WO_PDF: "Work order PDF",
  INSPECTION_PDF: "Inspection report PDF", LETTER_PDF: "Letter PDF", PAYMENT_RECEIPT_PDF: "Payment receipt PDF",
};
const ATTACHMENT_DEFAULT_FILENAME: Record<string, string> = {
  INVOICE_PDF: "invoice.pdf", QUOTATION_PDF: "quotation.pdf", WO_PDF: "work-order.pdf",
  INSPECTION_PDF: "inspection-report.pdf", LETTER_PDF: "letter.pdf", PAYMENT_RECEIPT_PDF: "receipt.pdf",
};

function safeParse<T>(json: string, fallback: T): T {
  try {
    const v = JSON.parse(json || "null") as T;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/** Controlled condition evaluation — no code execution ever (§34). */
function conditionMatches(cond: EmailCondition, data: Record<string, string>, payload: Record<string, unknown>): boolean {
  const get = (path: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(data, path)) return data[path];
    const parts = path.split(".");
    let cur: unknown = payload;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
      else return undefined;
    }
    return cur === undefined || cur === null ? undefined : String(cur);
  };
  const actual = get(cond.field);
  const expected = cond.value === undefined ? "" : String(cond.value);
  const num = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  switch (cond.op) {
    case "exists": return cond.value ? actual !== undefined && actual !== "" : actual === undefined || actual === "";
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "in": return actual !== undefined && expected.split(",").map((s) => s.trim()).includes(actual);
    case "nin": return actual === undefined || !expected.split(",").map((s) => s.trim()).includes(actual);
    case "gt": case "gte": case "lt": case "lte": {
      const a = num(actual); const b = num(expected);
      if (a === null || b === null) return false;
      return cond.op === "gt" ? a > b : cond.op === "gte" ? a >= b : cond.op === "lt" ? a < b : a <= b;
    }
    default: return false;
  }
}

// ─── Recipient engine (§23) ─────────────────────────────────────────────────

async function resolveRecipients(rule: RecipientRule, ctx: { resourceType: string; resourceId: string; payload: Record<string, unknown> }): Promise<string[]> {
  switch (rule.kind) {
    case "CUSTOMER":
      return [await customerEmailFor(ctx)].filter((v): v is string => Boolean(v));
    case "RELATED_USER": {
      // 1) explicit payload user (EMAIL_SEND convention), 2) the related
      //    entity's assignee (technician), 3) customer portal user.
      const direct = String(ctx.payload.userId ?? "");
      if (direct) {
        const u = await db.user.findUnique({ where: { id: direct }, select: { email: true } });
        if (u?.email) return [u.email];
      }
      const assignee = await assigneeEmailFor(ctx);
      if (assignee) return [assignee];
      const customer = await customerEmailFor(ctx);
      return customer ? [customer] : [];
    }
    case "ROLE": {
      const users = await db.user.findMany({ where: { role: rule.value, status: "ACTIVE" }, select: { email: true } });
      return users.map((u) => u.email);
    }
    case "MODULE_MAILBOX": {
      const key = /^company_email_[a-z]+$/.test(rule.value) ? rule.value : "company_email_info";
      const row = await db.setting.findUnique({ where: { key } });
      const email = row?.value?.trim();
      if (email && isValidAddr(email)) return [email];
      const info = await db.setting.findUnique({ where: { key: "company_email_info" } });
      return info?.value && isValidAddr(info.value) ? [info.value] : [];
    }
    case "FIXED":
      return isValidAddr(rule.value) ? [rule.value] : [];
    default:
      return [];
  }
}

async function customerEmailFor(ctx: { resourceType: string; resourceId: string }): Promise<string | null> {
  const sel = { email: true } as const;
  switch (ctx.resourceType) {
    case "COMPLAINT": {
      const c = await db.complaint.findUnique({ where: { id: ctx.resourceId }, select: { customer: { select: sel } } });
      return c?.customer?.email ?? null;
    }
    case "WORK_ORDER": {
      const w = await db.workOrder.findUnique({ where: { id: ctx.resourceId }, select: { customer: { select: sel } } });
      return w?.customer?.email ?? null;
    }
    case "QUOTATION": {
      const q = await db.quotation.findUnique({ where: { id: ctx.resourceId }, select: { customer: { select: sel } } });
      return q?.customer?.email ?? null;
    }
    case "INVOICE": {
      const i = await db.invoice.findUnique({ where: { id: ctx.resourceId }, select: { customer: { select: sel } } });
      return i?.customer?.email ?? null;
    }
    case "INSPECTION_REPORT": {
      const r = await db.inspectionReport.findUnique({ where: { id: ctx.resourceId }, select: { project: { select: { customer: { select: sel } } } } });
      return r?.project?.customer?.email ?? null;
    }
    default: return null;
  }
}

async function assigneeEmailFor(ctx: { resourceType: string; resourceId: string }): Promise<string | null> {
  const techUser = { user: { select: { email: true } } } as const;
  switch (ctx.resourceType) {
    case "COMPLAINT": {
      const c = await db.complaint.findUnique({ where: { id: ctx.resourceId }, select: { assignedTechnician: { select: techUser } } });
      return c?.assignedTechnician?.user?.email ?? null;
    }
    case "WORK_ORDER": {
      const w = await db.workOrder.findUnique({ where: { id: ctx.resourceId }, select: { technician: { select: techUser } } });
      return w?.technician?.user?.email ?? null;
    }
    case "PM_TASK": {
      const t = await db.pmTask.findUnique({ where: { id: ctx.resourceId }, select: { technician: { select: techUser } } });
      return t?.technician?.user?.email ?? null;
    }
    default: return null;
  }
}

// ─── 5. Email worker (§53 — reused scheduler loop; §36 retries; §37 dead-letter) ──

const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000]; // 1m, 5m, 15m
const BODY_RETENTION_DAYS = 30;
let lastPruneAt = 0;

let logoBuffer: Buffer | null | undefined;
function getLogoBuffer(): Buffer | null {
  if (logoBuffer !== undefined) return logoBuffer;
  try {
    logoBuffer = fs.readFileSync(path.join(process.cwd(), "public", "brand", "logo-128.png"));
  } catch {
    logoBuffer = null;
  }
  return logoBuffer;
}

const g = globalThis as unknown as { __hmsEmailTickRunning?: boolean };

/** Process due queued emails. Called from the existing 10s scheduler tick. */
export async function tickEmailWorker(): Promise<number> {
  if (g.__hmsEmailTickRunning) return 0;
  g.__hmsEmailTickRunning = true;
  let sent = 0;
  try {
    const cfg = await getEmailConfig();
    const smtpReady = Boolean(cfg.smtpHost && (cfg.fromEmail || cfg.smtpUser));

    const due = await db.emailLog.findMany({
      where: { status: "QUEUED", scheduledAt: { lte: new Date() } },
      orderBy: { scheduledAt: "asc" },
      take: 10,
      select: { id: true },
    });

    for (const { id } of due) {
      // Claim (status guard) — concurrent ticks can never double-send.
      const claim = await db.emailLog.updateMany({
        where: { id, status: "QUEUED" },
        data: { status: "PROCESSING", attemptCount: { increment: 1 } },
      });
      if (claim.count !== 1) continue;
      const log = await db.emailLog.findUnique({ where: { id } });
      if (!log) continue;
      try {
        sent += (await processOne(log.id, smtpReady)) ? 1 : 0;
      } catch (e) {
        await failOrRetry(log.id, log.attemptCount, log.maxAttempts, "PROVIDER", e instanceof Error ? e.message : String(e), "");
      }
    }

    // Retention (§56): prune rendered bodies older than the window (hourly).
    if (Date.now() - lastPruneAt > 3_600_000) {
      lastPruneAt = Date.now();
      const cutoff = new Date(Date.now() - BODY_RETENTION_DAYS * 86_400_000);
      await db.emailLog.updateMany({
        where: { bodyPrunedAt: null, createdAt: { lt: cutoff }, bodyHtml: { not: "" } },
        data: { bodyHtml: "", bodyPrunedAt: new Date() },
      }).catch(() => undefined);
    }
  } catch (e) {
    console.error("email-worker-tick-failed", e);
  } finally {
    g.__hmsEmailTickRunning = false;
  }
  return sent;
}

async function processOne(id: string, smtpReady: boolean): Promise<boolean> {
  const log = await db.emailLog.findUnique({ where: { id } });
  if (!log) return false;

  if (!smtpReady) {
    // CONFIG state: stays queued without burning attempts — honest error shown (§70).
    await db.emailLog.update({ where: { id }, data: { status: "QUEUED", attemptCount: { decrement: 1 }, lastError: "SMTP is not configured — email stays queued.", errorClass: "CONFIG" } });
    return false;
  }
  if (!(await emailChannelEnabled()) && !log.isTest) {
    await db.emailLog.update({ where: { id }, data: { status: "QUEUED", attemptCount: { decrement: 1 }, lastError: "Email channel disabled in settings.", errorClass: "CONFIG" } });
    return false;
  }

  const sender = { fromName: log.fromName, fromEmail: log.fromEmail, replyTo: log.replyTo };

  // ── Attachments (§21/§22) — resolved at send time through authorized entities.
  let attachments: { filename: string; content: Buffer; contentType: string; cid?: string }[] = [];
  const specs = safeParse<AttachmentSpec[]>(log.attachmentRefs, []).filter((s) => s && typeof s === "object" && "kind" in s);
  const attachmentNotes: string[] = [];
  if (specs.length > 0) {
    const resolved = await resolveAttachments(specs, { resourceType: log.relatedType, resourceId: log.relatedId });
    attachments = resolved.attachments.map((a) => ({ filename: a.filename, content: a.buffer, contentType: a.contentType }));
    attachmentNotes.push(...resolved.errors);
    if (resolved.attachments.length === 0 && resolved.errors.length > 0) {
      await failOrRetry(id, log.attemptCount, log.maxAttempts, "PERMANENT", `Attachment could not be resolved: ${resolved.errors.join("; ")}`, "");
      return false;
    }
  }

  // ── Inline logo (CID) for the branded shell.
  const logo = getLogoBuffer();
  if (logo) attachments.push({ filename: "logo.png", content: logo, contentType: "image/png", cid: "mohd-hms-logo" });

  // ── REAL SMTP send (§70 — no fake success).
  const result = await smtpProvider.send({
    to: log.toEmail,
    cc: log.cc ? log.cc.split(",").map((a) => a.trim()).filter(Boolean) : undefined,
    bcc: log.bcc ? log.bcc.split(",").map((a) => a.trim()).filter(Boolean) : undefined,
    replyTo: sender.replyTo || undefined,
    fromName: sender.fromName,
    fromEmail: sender.fromEmail,
    subject: log.subject,
    html: log.bodyHtml,
    text: htmlFallbackText(log.bodyHtml),
    attachments,
    timeoutMs: (await getEmailConfig()).timeoutMs,
  });

  if (result.ok) {
    // SENT = accepted by the SMTP server (response stored as evidence, §54).
    await db.emailLog.update({
      where: { id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        messageId: result.messageId,
        providerResponse: [result.response, ...attachmentNotes].filter(Boolean).join(" | ").slice(0, 2000),
        lastError: "",
        errorClass: "",
        failedAt: null,
      },
    });
    return true;
  }

  const permanent = result.errorClass === "PERMANENT" || result.errorClass === "AUTHENTICATION" || result.errorClass === "RECIPIENT";
  await failOrRetry(id, log.attemptCount, log.maxAttempts, result.errorClass ?? "PROVIDER", result.error ?? "SMTP send failed", result.response, permanent);
  return false;
}

function htmlFallbackText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 5000);
}

async function failOrRetry(id: string, attemptCount: number, maxAttempts: number, errorClass: string, error: string, response: string, permanent = false): Promise<void> {
  const canRetry = !permanent && attemptCount < Math.max(1, maxAttempts);
  const backoff = BACKOFF_MS[Math.min(attemptCount - 1, BACKOFF_MS.length - 1)] ?? 60_000;
  await db.emailLog.update({
    where: { id },
    data: canRetry
      ? { status: "QUEUED", scheduledAt: new Date(Date.now() + backoff), lastError: error.slice(0, 2000), errorClass, providerResponse: response.slice(0, 2000) }
      : { status: "DEAD_LETTER", failedAt: new Date(), lastError: error.slice(0, 2000), errorClass, providerResponse: response.slice(0, 2000) },
  }).catch(() => undefined);
  if (!canRetry) {
    await audit({ actorEmail: "SYSTEM", action: "EMAIL_DEAD_LETTER", resourceType: "EMAIL", resourceId: id, metadata: { errorClass, error: error.slice(0, 300) } }).catch(() => undefined);
  }
}

// ─── 6. Admin operations (§27/§28/§37/§43/§44) ──────────────────────────────

export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  const result = await smtpProvider.verify();
  const { recordVerifyResult } = await import("./config");
  await recordVerifyResult(result.ok);
  return { ok: result.ok, detail: result.detail };
}

/**
 * Send a test email with SAFE sample data (§44). Sends synchronously and
 * returns the REAL result — the UI never shows success unless SMTP accepted.
 */
export async function sendTestEmail(params: { to: string; templateId?: string }): Promise<{ ok: boolean; detail: string; logId?: string }> {
  const cfg = await getEmailConfig();
  if (!cfg.smtpHost) return { ok: false, detail: "SMTP host is not configured." };
  if (!isValidAddr(params.to)) return { ok: false, detail: "The test recipient address is not valid." };

  let rendered: RenderedEmail;
  let templateKey = "GENERAL_NOTIFICATION";
  let templateVersion = 0;
  let subject: string;

  if (params.templateId) {
    // Accept EITHER the template's DB id or its canonical key — the admin UI
    // test-send selector sends the key (from /email/meta), older callers send id.
    const template = (await db.emailTemplate.findUnique({ where: { id: params.templateId } }))
      ?? (await db.emailTemplate.findUnique({ where: { key: params.templateId } }));
    if (!template) return { ok: false, detail: "Template not found." };
    const data = await sampleDataFor(template.key);
    rendered = await renderTemplate({ subject: template.subject, bodyHtml: template.bodyHtml, data });
    templateKey = template.key;
    templateVersion = template.version;
    subject = `[TEST] ${rendered.subject}`;
  } else {
    const data = await sampleDataFor("GENERAL_NOTIFICATION");
    rendered = await renderTemplate({
      subject: "MOHD.HMS Enterprise — SMTP test email",
      bodyHtml: `<h2 style="margin:0 0 14px 0;font-size:18px;color:#14532d;">SMTP configuration works</h2><p style="margin:0 0 12px 0;">This is a <strong>test email</strong> sent from the MOHD.HMS Enterprise email configuration panel.</p><p style="margin:0;">If you received this message, the SMTP settings are working correctly.</p>`,
      data,
    });
    subject = `[TEST] MOHD.HMS Enterprise — SMTP test email`;
  }

  const sender = await senderFor();
  const logo = getLogoBuffer();
  const result = await smtpProvider.send({
    to: params.to.trim(),
    fromName: sender.fromName,
    fromEmail: sender.fromEmail,
    replyTo: sender.replyTo || undefined,
    subject,
    html: rendered.html,
    text: rendered.text,
    attachments: logo ? [{ filename: "logo.png", content: logo, contentType: "image/png", cid: "mohd-hms-logo" }] : [],
    timeoutMs: cfg.timeoutMs,
  });

  // Record the REAL result in the email log (§28 — do not fake the result).
  const row = await db.emailLog.create({
    data: {
      status: result.ok ? "SENT" : "FAILED",
      templateKey,
      templateVersion,
      category: "SYSTEM",
      toEmail: params.to.trim(),
      fromName: sender.fromName,
      fromEmail: sender.fromEmail,
      subject: headerSafe(subject).slice(0, 500),
      bodyHtml: rendered.html,
      isTest: true,
      attemptCount: 1,
      sentAt: result.ok ? new Date() : null,
      failedAt: result.ok ? null : new Date(),
      lastError: result.ok ? "" : (result.error ?? "").slice(0, 2000),
      errorClass: result.ok ? "" : result.errorClass ?? "PROVIDER",
      messageId: result.messageId,
      providerResponse: result.response,
    },
  });

  await audit({
    action: result.ok ? "EMAIL_TEST_SENT" : "EMAIL_TEST_FAILED",
    resourceType: "EMAIL", resourceId: row.id,
    metadata: { to: params.to, templateKey, ok: result.ok }, // never credentials (§59)
  }).catch(() => undefined);

  return result.ok
    ? { ok: true, detail: `Test email sent — accepted by SMTP (${result.response || "250 OK"})`, logId: row.id }
    : { ok: false, detail: result.error || "The SMTP server did not accept the test email.", logId: row.id };
}

export async function retryEmail(id: string): Promise<{ ok: boolean; reason?: string }> {
  const log = await db.emailLog.findUnique({ where: { id }, select: { status: true } });
  if (!log) return { ok: false, reason: "not found" };
  if (log.status === "SENT") return { ok: false, reason: "already sent — retrying would duplicate the email" };
  if (!["FAILED", "DEAD_LETTER", "CANCELED", "QUEUED"].includes(log.status)) return { ok: false, reason: `cannot retry from ${log.status}` };
  const updated = await db.emailLog.updateMany({
    where: { id, status: { in: ["FAILED", "DEAD_LETTER", "CANCELED", "QUEUED"] } },
    data: { status: "QUEUED", scheduledAt: new Date(), lastError: "", errorClass: "", failedAt: null },
  });
  if (updated.count === 1) await audit({ action: "EMAIL_RETRIED", resourceType: "EMAIL", resourceId: id }).catch(() => undefined);
  return { ok: updated.count === 1, reason: updated.count === 1 ? undefined : "state changed" };
}

export async function cancelEmail(id: string): Promise<{ ok: boolean; reason?: string }> {
  const log = await db.emailLog.findUnique({ where: { id }, select: { status: true } });
  if (!log) return { ok: false, reason: "not found" };
  if (log.status === "SENT") return { ok: false, reason: "already sent" };
  const updated = await db.emailLog.updateMany({
    where: { id, status: { in: ["QUEUED", "FAILED"] } },
    data: { status: "CANCELED", failedAt: new Date() },
  });
  if (updated.count === 1) await audit({ action: "EMAIL_CANCELED", resourceType: "EMAIL", resourceId: id }).catch(() => undefined);
  return { ok: updated.count === 1, reason: updated.count === 1 ? undefined : `cannot cancel from ${log.status}` };
}

/** Safe sample data for previews and test sends (§43 — clearly marked, no real customer data). */
export async function sampleDataFor(templateKey: string): Promise<Record<string, string>> {
  const base = await resolveTemplateData(templateKey, {
    eventType: "PREVIEW", resourceType: "", resourceId: "", payload: {},
    user: { id: "sample", email: "sample@example.com", name: "Sample User" },
    extra: sampleValues(),
  });
  return base;
}

function sampleValues(): Record<string, string> {
  const today = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date());
  const in14 = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(Date.now() + 14 * 86_400_000));
  return {
    COMPLAINT_NUMBER: "CPT-2026-0001", COMPLAINT_TITLE: "Air conditioning unit not cooling",
    COMPLAINT_PRIORITY: "HIGH", COMPLAINT_LOCATION: "Level 3 — Server Room", COMPLAINT_STATUS: "NEW",
    CUSTOMER_NAME: "Sample Customer Sdn. Bhd.", TECHNICIAN_NAME: "Sample Technician",
    WORK_ORDER_NUMBER: "WO-2026-0001", WORK_ORDER_TITLE: "AC servicing — Level 3", WORK_ORDER_PRIORITY: "MEDIUM",
    WORK_ORDER_STATUS: "PENDING", WORK_ORDER_TOTAL: "BND 450.00",
    QUOTATION_NUMBER: "QTN-2026-0001", QUOTATION_DATE: today, QUOTATION_TOTAL: "BND 1,200.00",
    QUOTATION_VALID_UNTIL: in14, QUOTATION_STATUS: "SENT",
    INVOICE_NUMBER: "INV-2026-0001", INVOICE_DATE: today, INVOICE_DUE_DATE: in14,
    INVOICE_TOTAL: "BND 1,200.00", INVOICE_BALANCE: "BND 1,200.00", INVOICE_STATUS: "SENT",
    PAYMENT_AMOUNT: "BND 600.00", PAYMENT_DATE: today,
    PM_PLAN_CODE: "PM-2026-0001", PM_PLAN_NAME: "Quarterly AC maintenance", PM_DUE_DATE: in14,
    EQUIPMENT_NAME: "AC Unit-12 (EQP-0045)",
    PURCHASE_NUMBER: "PO-2026-0001", SUPPLIER_NAME: "Sample Supplier", PURCHASE_TOTAL: "BND 890.00", PURCHASE_STATUS: "SENT",
    REPORT_NUMBER: "IRMS-2026-0001", PROJECT_NAME: "Sample Mall — Quarterly Inspection",
    REPORT_STATUS: "APPROVED", INSPECTOR_NAME: "Sample Inspector",
    LETTER_NUMBER: "HMS/HR/EMP/2026/0001", LETTER_DATE: today, LETTER_SUBJECT: "Employment Letter",
    NOTIFICATION_TITLE: "Sample notification", NOTIFICATION_MESSAGE: "This is a sample notification used for preview and test renders only.",
    ALERT_TITLE: "Low stock: AC filter", ALERT_MESSAGE: "AC filter (FLT-001) is at 2 units — minimum is 5. Please restock.",
    OTP_CODE: "123456", OTP_EXPIRY_MINUTES: "10",
  };
}

/** Per-user preference guard for OPTIONAL categories (§40/§41). */
export async function isSuppressedForUser(category: string, userEmail: string): Promise<boolean> {
  if (!["REPORTS", "SYSTEM"].includes(category)) return false; // security-critical never suppressed
  const key = `email_pref_optout:${userEmail.toLowerCase()}:${category}`;
  const row = await db.setting.findUnique({ where: { key } }).catch(() => null);
  return row?.value === "1";
}

// ─── 7. Health metrics (§29 — real data only) ───────────────────────────────

export async function emailHealth() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [sentToday, failedToday, queued, retrying, lastSent, lastFailed, cfg] = await Promise.all([
    db.emailLog.count({ where: { status: "SENT", sentAt: { gte: startOfDay } } }),
    db.emailLog.count({ where: { status: { in: ["FAILED", "DEAD_LETTER"] }, failedAt: { gte: startOfDay } } }),
    db.emailLog.count({ where: { status: "QUEUED" } }),
    db.emailLog.count({ where: { status: "QUEUED", attemptCount: { gt: 0 } } }),
    db.emailLog.findFirst({ where: { status: "SENT" }, orderBy: { sentAt: "desc" }, select: { sentAt: true, toEmail: true, subject: true } }),
    db.emailLog.findFirst({ where: { status: { in: ["FAILED", "DEAD_LETTER"] } }, orderBy: { failedAt: "desc" }, select: { failedAt: true, toEmail: true, lastError: true } }),
    getEmailConfig(),
  ]);
  return {
    sentToday, failedToday, queued, retrying,
    lastSuccess: lastSent ? { at: lastSent.sentAt?.toISOString() ?? null, to: lastSent.toEmail, subject: lastSent.subject } : null,
    lastFailure: lastFailed ? { at: lastFailed.failedAt?.toISOString() ?? null, to: lastFailed.toEmail, error: lastFailed.lastError } : null,
    smtp: {
      configured: Boolean(cfg.smtpHost && (cfg.fromEmail || cfg.smtpUser)),
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      security: cfg.smtpSecurity,
      lastVerifyAt: cfg.lastVerifyAt?.toISOString() ?? null,
      lastVerifyOk: cfg.lastVerifyOk,
    },
  };
}
