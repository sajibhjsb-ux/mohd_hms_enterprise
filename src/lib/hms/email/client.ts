// MOHD.HMS ENTERPRISE — Email client service (user-facing mailboxes, /email).
//
// WHAT THIS IS: the user-facing email client — mailboxes, messages, folders,
// drafts, flags, search and attachments (spec §6–§30).
//
// WHAT THIS IS NOT: a second email system. ALL real SMTP delivery is
// delegated to the ONE centralized EmailService (service.ts): a send creates
// a MailMessage plus ONE EmailLog (relatedType="MAIL_MESSAGE") whose existing
// worker performs the real SMTP send, retries with backoff and honest status;
// syncMailMessageDelivery mirrors that authoritative state back here.
// Attachments live in MinIO (mail-owned keys after send; the user's Files
// FileEntry key while attached to a draft) — metadata only in PostgreSQL.
//
// SECURITY MODEL (§44/§45/§36/§37):
//   • Route permission email.client is the COARSE gate; mailbox membership is
//     the OBJECT gate. A user only ever touches mailboxes they own or are a
//     member of — even SUPER_ADMIN sees no mailbox content without membership
//     (private correspondence, same stance as the Files module).
//   • The sender identity is resolved server-side from the APPROVED Mailbox
//     row — a browser can never choose an arbitrary From address.
//   • Recipients are validated server-side (format, counts, header injection).
//   • Attachments are re-resolved from FileEntry rows via the Files module's
//     object-level authorization (canAccessFile) — browser metadata is never
//     trusted; object keys are copied into a mail-owned MinIO prefix on send.
//   • BCC is stored only on the sender's own message and never re-exposed by
//     reply-all (§17).

import "server-only";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import {
  canAccessFile, assertRolePermission, assertQuota, extOf,
  sanitizeFileName, sniffMimeType, sha256,
} from "@/lib/hms/files/service";
import { getEmailConfig, isValidEmail } from "./config";
import { parseGroupMembers } from "./groups";
import { queueClientEmail, retryEmail } from "./service";

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const MAIL_FOLDERS = ["INBOX", "SENT", "DRAFTS", "OUTBOX", "ARCHIVE", "SPAM", "TRASH"] as const;
export const MAIL_VIRTUAL_FOLDERS = ["STARRED", "IMPORTANT"] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number] | (typeof MAIL_VIRTUAL_FOLDERS)[number];

export const MAIL_MAX_RECIPIENTS = 100;
export const MAIL_MAX_BODY_CHARS = 200_000;
export const MAIL_MAX_ATTACHMENTS = 10;
export const MAIL_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAIL_MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB per message
export const MAIL_PAGE_SIZE = 25;

const LIST_SELECT = {
  id: true, mailboxId: true, folder: true, status: true, direction: true, threadId: true,
  subject: true, fromName: true, fromEmail: true, toEmail: true, ccEmail: true,
  bodyText: true, readAt: true, starredAt: true, important: true, sentAt: true,
  lastError: true, messageId: true, createdAt: true,
  _count: { select: { attachments: true } },
} satisfies Prisma.MailMessageSelect;

type ListMessage = Prisma.MailMessageGetPayload<{ select: typeof LIST_SELECT }>;

// ─── Mailbox access (§28 — configurable mapping; §44 — object gate) ─────────

export type MyMailbox = {
  id: string; email: string; displayName: string; kind: string; canSend: boolean;
};

/** Every ACTIVE mailbox the user can READ (owner or member). */
export async function myMailboxes(userId: string): Promise<(MyMailbox & { unread: number })[]> {
  const rows = await db.mailbox.findMany({
    where: {
      isActive: true,
      OR: [{ ownerUserId: userId }, { members: { some: { userId } } }],
    },
    include: { members: { where: { userId }, select: { canSend: true } } },
    orderBy: [{ kind: "asc" }, { email: "asc" }],
  });
  const ids = rows.map((r) => r.id);
  const unreadByMailbox = new Map<string, number>();
  if (ids.length > 0) {
    const groups = await db.mailMessage.groupBy({
      by: ["mailboxId"],
      where: { mailboxId: { in: ids }, folder: "INBOX", readAt: null },
      _count: { _all: true },
    });
    for (const grp of groups) unreadByMailbox.set(grp.mailboxId, grp._count._all);
  }
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    kind: r.kind,
    canSend: r.kind === "PERSONAL"
      ? r.ownerUserId === userId && (r.members[0]?.canSend ?? true)
      : (r.members[0]?.canSend ?? false),
    unread: unreadByMailbox.get(r.id) ?? 0,
  }));
}

async function readableMailboxIds(userId: string): Promise<string[]> {
  const rows = await db.mailbox.findMany({
    where: { isActive: true, OR: [{ ownerUserId: userId }, { members: { some: { userId } } }] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Assert the user can READ a mailbox; throws 404 (existence hidden) otherwise. */
async function assertReadableMailbox(userId: string, mailboxId: string) {
  const mailbox = await db.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox || !mailbox.isActive) throw Errors.notFound("Mailbox not found.");
  const member = await db.mailboxMember.findUnique({ where: { mailboxId_userId: { mailboxId, userId } } });
  if (mailbox.ownerUserId !== userId && !member) throw Errors.notFound("Mailbox not found.");
  return mailbox;
}

/** Assert the user can SEND from a mailbox (§45 — backend-approved identity). */
async function assertSendableMailbox(userId: string, mailboxId: string) {
  const mailbox = await assertReadableMailbox(userId, mailboxId);
  const member = await db.mailboxMember.findUnique({ where: { mailboxId_userId: { mailboxId, userId } } });
  const isOwner = mailbox.ownerUserId === userId;
  const canSend = mailbox.kind === "PERSONAL"
    ? isOwner && (member?.canSend ?? true)
    : (member?.canSend ?? false);
  if (!canSend) throw Errors.forbidden("You are not allowed to send from this mailbox.");
  return mailbox;
}

// ─── Recipient parsing / validation (§11/§12) ───────────────────────────────

export function parseRecipients(input: string[] | string | undefined | null): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(/[,;\s]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const addr = String(item ?? "").trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

function validateRecipients(to: string[], cc: string[], bcc: string[]): void {
  const all = [...to, ...cc, ...bcc];
  if (to.length === 0) throw Errors.badRequest("Add at least one recipient in the To field.");
  if (all.length > MAIL_MAX_RECIPIENTS) throw Errors.badRequest(`Too many recipients — the limit is ${MAIL_MAX_RECIPIENTS} per email.`);
  for (const addr of all) {
    if (!isValidEmail(addr)) throw Errors.badRequest(`"${addr.slice(0, 60)}" is not a valid email address.`);
  }
}

// ─── Body generation (plain-text compose → safe HTML; §11) ──────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Turn a plain-text compose body into safe HTML: escape → links → paragraphs. */
export function composeHtml(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, (m) => `<a href="${m}" rel="noopener noreferrer" target="_blank">${m}</a>`);
  const paragraphs = linked.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px 0;">${p.replace(/\n/g, "<br/>")}</p>`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;">${paragraphs.join("")}</div>`;
}

/** Defense-in-depth strip of active content before quoting stored HTML. */
function sanitizeQuotedHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

function quoteBlock(orig: { fromName: string; fromEmail: string; createdAt: Date; bodyHtml: string; bodyText: string }): string {
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(orig.createdAt);
  const author = orig.fromName || orig.fromEmail;
  return [
    `<div style="margin:16px 0 0 0;padding:10px 0 0 0;border-top:1px solid #e2e8f0;">`,
    `<p style="margin:0 0 8px 0;color:#64748b;font-size:12px;">On ${date}, ${escapeHtml(author)} &lt;${escapeHtml(orig.fromEmail)}&gt; wrote:</p>`,
    `<blockquote style="margin:0;padding:0 0 0 12px;border-left:3px solid #cbd5e1;color:#475569;">${sanitizeQuotedHtml(orig.bodyHtml || escapeHtml(orig.bodyText))}</blockquote>`,
    `</div>`,
  ].join("");
}

export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s || "(no subject)"}`;
}

export function forwardSubject(subject: string): string {
  const s = subject.trim();
  return /^fwd\s*:/i.test(s) ? s : `Fwd: ${s || "(no subject)"}`;
}

// ─── Attachments ────────────────────────────────────────────────────────────

export type AttachInput = { fileId: string };

/** Attach one existing File (the user's own or shared with them — §20). */
export async function attachFileToMessage(user: { id: string }, messageId: string, fileId: string) {
  const message = await accessibleMessage(user.id, messageId);
  if (message.folder !== "DRAFTS" || message.status !== "DRAFT") throw Errors.badRequest("Attachments can only be changed on drafts.");
  // Object-level authorization through the ONE Files authorization core.
  await canAccessFile(user, fileId, "DOWNLOAD");
  const file = await db.fileEntry.findUnique({ where: { id: fileId } });
  if (!file) throw Errors.notFound("File not found.");
  await assertAttachmentRoom(message.id, file.sizeBytes);
  const count = await db.mailAttachment.count({ where: { messageId: message.id } });
  if (count >= MAIL_MAX_ATTACHMENTS) throw Errors.badRequest(`Too many attachments — the limit is ${MAIL_MAX_ATTACHMENTS} per email.`);
  const row = await db.mailAttachment.create({
    data: {
      messageId: message.id, filename: file.name, contentType: file.mimeType,
      sizeBytes: file.sizeBytes, objectKey: file.objectKey, fileId: file.id,
    },
  });
  await audit({ actorId: user.id, actorEmail: (user as { email?: string }).email ?? "", action: "MAIL_ATTACHMENT_ADDED", resourceType: "MAIL_MESSAGE", resourceId: message.id, metadata: { filename: file.name, sizeBytes: file.sizeBytes } });
  return row;
}

async function assertAttachmentRoom(messageId: string, incomingBytes: number): Promise<void> {
  const agg = await db.mailAttachment.aggregate({ where: { messageId }, _sum: { sizeBytes: true } });
  const total = (agg._sum.sizeBytes ?? 0) + incomingBytes;
  if (total > MAIL_MAX_TOTAL_ATTACHMENT_BYTES) {
    throw Errors.badRequest(`Attachments are too large — the total limit is ${Math.round(MAIL_MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024))} MB per email.`);
  }
}

export async function detachAttachment(user: { id: string }, messageId: string, attachmentId: string) {
  const message = await accessibleMessage(user.id, messageId);
  if (message.folder !== "DRAFTS" || message.status !== "DRAFT") throw Errors.badRequest("Attachments can only be changed on drafts.");
  const att = await db.mailAttachment.findFirst({ where: { id: attachmentId, messageId: message.id } });
  if (!att) throw Errors.notFound("Attachment not found.");
  await db.mailAttachment.delete({ where: { id: att.id } });
  await audit({ actorId: user.id, action: "MAIL_ATTACHMENT_REMOVED", resourceType: "MAIL_MESSAGE", resourceId: message.id, metadata: { filename: att.filename } });
}

/**
 * Materialize a draft attachment into the mail-owned MinIO prefix so the sent
 * email is immutable even if the source File changes/disappears later.
 */
async function materializeAttachment(messageId: string, att: { id: string; filename: string; contentType: string; sizeBytes: number; objectKey: string; fileId: string }) {
  let key = att.objectKey;
  let contentType = att.contentType;
  if (att.fileId) {
    // Draft attached a user FileEntry — copy its CURRENT object into mail/.
    const src = await storage.get(att.objectKey);
    if (!src) throw Errors.badRequest(`Attachment "${att.filename}" is no longer available in storage. Remove it and attach the file again.`);
    contentType = att.contentType || src.contentType;
    key = `mail/messages/${messageId}/${att.id}/${sanitizeFileName(att.filename) || randomUUID()}`;
    await storage.put(key, src.buffer, contentType);
    await db.mailAttachment.update({ where: { id: att.id }, data: { objectKey: key } });
  }
  return { filename: att.filename, contentType, key };
}

// ─── Drafts (§10 — persisted in PostgreSQL, never localStorage) ─────────────

export type DraftInput = {
  mailboxId?: string;
  to?: string[] | string;
  cc?: string[] | string;
  bcc?: string[] | string;
  subject?: string;
  body?: string;
  attachmentFileIds?: string[];
  /** Forward mode: clone the original message's attachments onto the draft (§18). */
  forwardFrom?: string;
};

function cleanText(v: unknown, max: number): string {
  return String(v ?? "").slice(0, max);
}

/** Subject header hygiene on the user-facing record too — never store CR/LF. */
function cleanSubject(v: unknown): string {
  return cleanText(v, 500).replace(/[\r\n]+/g, " ").trim();
}

export async function createDraft(user: { id: string; email: string }, input: DraftInput) {
  if (!input.mailboxId) throw Errors.badRequest("Select a mailbox to write from.");
  const mailbox = await assertSendableMailbox(user.id, input.mailboxId);
  const to = parseRecipients(input.to);
  const cc = parseRecipients(input.cc);
  const bcc = parseRecipients(input.bcc);
  const subject = cleanSubject(input.subject);
  const body = cleanText(input.body, MAIL_MAX_BODY_CHARS);
  const message = await db.mailMessage.create({
    data: {
      mailboxId: mailbox.id, folder: "DRAFTS", status: "DRAFT", direction: "OUT",
      subject, bodyText: body, bodyHtml: composeHtml(body),
      fromEmail: mailbox.email, fromName: mailbox.displayName,
      toEmail: to.join(", "), ccEmail: cc.join(", "), bccEmail: bcc.join(", "),
    },
  });
  await db.mailMessage.update({ where: { id: message.id }, data: { threadId: message.id } });
  await syncDraftAttachments(user, message.id, input.attachmentFileIds ?? []);
  if (input.forwardFrom) {
    const cloned = await cloneAttachmentsForForward(user.id, input.forwardFrom, message.id);
    if (cloned > 0) await audit({ actorId: user.id, action: "MAIL_ATTACHMENTS_FORWARDED", resourceType: "MAIL_MESSAGE", resourceId: message.id, metadata: { from: input.forwardFrom, count: cloned } });
  }
  await audit({ actorId: user.id, actorEmail: user.email, action: "MAIL_DRAFT_CREATED", resourceType: "MAIL_MESSAGE", resourceId: message.id, metadata: { mailbox: mailbox.email } });
  return getMessage(user.id, message.id);
}

export async function updateDraft(user: { id: string; email: string }, messageId: string, input: DraftInput) {
  const message = await accessibleMessage(user.id, messageId);
  if (message.folder !== "DRAFTS" || message.status !== "DRAFT") throw Errors.badRequest("Only drafts can be edited.");
  const mailbox = await assertSendableMailbox(user.id, input.mailboxId || message.mailboxId);
  const data: Record<string, unknown> = {
    mailboxId: mailbox.id,
    toEmail: parseRecipients(input.to).join(", "),
    ccEmail: parseRecipients(input.cc).join(", "),
    bccEmail: parseRecipients(input.bcc).join(", "),
    subject: cleanSubject(input.subject),
    bodyText: cleanText(input.body, MAIL_MAX_BODY_CHARS),
  };
  data.bodyHtml = composeHtml(String(data.bodyText));
  data.fromEmail = mailbox.email;
  data.fromName = mailbox.displayName;
  await db.mailMessage.update({ where: { id: message.id }, data });
  if (input.attachmentFileIds) await syncDraftAttachments(user, message.id, input.attachmentFileIds);
  await audit({ actorId: user.id, actorEmail: user.email, action: "MAIL_DRAFT_UPDATED", resourceType: "MAIL_MESSAGE", resourceId: message.id });
  return getMessage(user.id, message.id);
}

async function syncDraftAttachments(user: { id: string }, messageId: string, fileIds: string[]) {
  const wanted = [...new Set(fileIds.filter(Boolean))].slice(0, MAIL_MAX_ATTACHMENTS);
  const current = await db.mailAttachment.findMany({ where: { messageId }, select: { id: true, fileId: true } });
  const keep = new Set(current.filter((a) => a.fileId && wanted.includes(a.fileId)).map((a) => a.id));
  for (const row of current) {
    if (!keep.has(row.id)) await db.mailAttachment.delete({ where: { id: row.id } }).catch(() => undefined);
  }
  const existingFiles = new Set(current.map((a) => a.fileId).filter(Boolean));
  let totalBytes = (await db.mailAttachment.aggregate({ where: { messageId }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;
  for (const fileId of wanted) {
    if (existingFiles.has(fileId)) continue;
    await canAccessFile(user, fileId, "DOWNLOAD");
    const file = await db.fileEntry.findUnique({ where: { id: fileId } });
    if (!file) continue;
    if (totalBytes + file.sizeBytes > MAIL_MAX_TOTAL_ATTACHMENT_BYTES) {
      throw Errors.badRequest(`Attachments are too large — the total limit is ${Math.round(MAIL_MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024))} MB per email.`);
    }
    await db.mailAttachment.create({
      data: { messageId, filename: file.name, contentType: file.mimeType, sizeBytes: file.sizeBytes, objectKey: file.objectKey, fileId: file.id },
    });
    totalBytes += file.sizeBytes;
  }
}

export async function deleteDraft(user: { id: string }, messageId: string) {
  const message = await accessibleMessage(user.id, messageId);
  if (message.status !== "DRAFT") throw Errors.badRequest("Only drafts can be discarded.");
  await db.mailMessage.delete({ where: { id: message.id } });
  await audit({ actorId: user.id, action: "MAIL_DRAFT_DELETED", resourceType: "MAIL_MESSAGE", resourceId: message.id, metadata: { subject: message.subject } });
}

// ─── Send (§12 — real send through the ONE EmailService) ────────────────────

export type SendInput = DraftInput & { draftId?: string };

/**
 * Resolve the mailbox that should receive a colleague's mail (INBOX copy).
 * Preference: their own PERSONAL mailbox → a PERSONAL mailbox they can read →
 * a SHARED mailbox they can read → auto-provision a PERSONAL mailbox at the
 * user's own email address (corporate-directory semantics — every staff
 * member can receive internal mail even before an admin assigns mailboxes).
 * Returns null only when the user's address is claimed by someone else's
 * personal mailbox and no other readable mailbox exists (nowhere honest to
 * deliver).
 */
async function inboxTargetMailbox(u: { id: string; email: string; name: string }): Promise<string | null> {
  const boxes = await db.mailbox.findMany({
    where: { isActive: true, OR: [{ ownerUserId: u.id }, { members: { some: { userId: u.id } } }] },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, ownerUserId: true },
  });
  const ownedPersonal = boxes.find((b) => b.kind === "PERSONAL" && b.ownerUserId === u.id);
  if (ownedPersonal) return ownedPersonal.id;
  const personalMember = boxes.find((b) => b.kind === "PERSONAL");
  if (personalMember) return personalMember.id;
  const shared = boxes.find((b) => b.kind === "SHARED");
  if (shared) return shared.id;
  const conflict = await db.mailbox.findUnique({ where: { email: u.email }, select: { id: true, kind: true } });
  if (conflict) {
    if (conflict.kind === "SHARED") {
      await db.mailboxMember
        .create({ data: { mailboxId: conflict.id, userId: u.id, canSend: false } })
        .catch(() => undefined);
      return conflict.id;
    }
    return null;
  }
  const created = await db.mailbox.create({
    data: { email: u.email, displayName: u.name, kind: "PERSONAL", ownerUserId: u.id },
    select: { id: true },
  });
  return created.id;
}

export async function sendCompose(user: { id: string; email: string }, input: SendInput) {
  // Resolve the working draft first (if any) so its mailbox is the default
  // sender — the browser never gets to pick an unapproved identity (§45).
  let draft = null as null | Awaited<ReturnType<typeof accessibleMessage>>;
  if (input.draftId) {
    draft = await accessibleMessage(user.id, input.draftId);
    if (draft.folder !== "DRAFTS" || draft.status !== "DRAFT") throw Errors.badRequest("Only drafts can be sent.");
  }
  // Resolve + authorize sender identity from the APPROVED mailbox (§45).
  const mailbox = await assertSendableMailbox(user.id, input.mailboxId || draft?.mailboxId || "");
  const to = parseRecipients(input.to);
  const cc = parseRecipients(input.cc);
  const bcc = parseRecipients(input.bcc);
  validateRecipients(to, cc, bcc);
  const subject = cleanSubject(input.subject);
  const body = cleanText(input.body, MAIL_MAX_BODY_CHARS);
  if (!subject.trim() && !body.trim() && (input.attachmentFileIds ?? []).length === 0) {
    throw Errors.badRequest("Write a message or add an attachment before sending.");
  }

  // Resolve the working message: the draft being sent, or a new message row.
  let message;
  if (input.draftId) {
    message = await accessibleMessage(user.id, input.draftId);
    if (message.folder !== "DRAFTS" || message.status !== "DRAFT") throw Errors.badRequest("Only drafts can be sent.");
    await db.mailMessage.update({
      where: { id: message.id },
      data: {
        mailboxId: mailbox.id, toEmail: to.join(", "), ccEmail: cc.join(", "), bccEmail: bcc.join(", "),
        subject, bodyText: body, bodyHtml: composeHtml(body), fromEmail: mailbox.email, fromName: mailbox.displayName,
      },
    });
  } else {
    message = await db.mailMessage.create({
      data: {
        mailboxId: mailbox.id, folder: "OUTBOX", status: "QUEUED", direction: "OUT",
        subject, bodyText: body, bodyHtml: composeHtml(body),
        fromEmail: mailbox.email, fromName: mailbox.displayName,
        toEmail: to.join(", "), ccEmail: cc.join(", "), bccEmail: bcc.join(", "),
      },
    });
    await db.mailMessage.update({ where: { id: message.id }, data: { threadId: message.id } });
  }
  if (input.attachmentFileIds) await syncDraftAttachments(user, message.id, input.attachmentFileIds);

  // Materialize attachments into the mail-owned MinIO prefix (§19/§20).
  const attachments = await db.mailAttachment.findMany({ where: { messageId: message.id } });
  const materialized: { filename: string; contentType: string; key: string }[] = [];
  try {
    for (const att of attachments) {
      materialized.push(await materializeAttachment(message.id, att));
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : "attachment could not be prepared";
    await db.mailMessage.update({ where: { id: message.id }, data: { status: "FAILED", lastError: reason } }).catch(() => undefined);
    throw Errors.badRequest(reason);
  }

  // ── Recipient classification — internal corporate mail vs external SMTP ──
  // A recipient is INTERNAL when the address is an active org mailbox OR an
  // active staff member's email. Internal recipients receive a REAL INBOX
  // copy in their mailbox and are excluded from the SMTP envelope (no double
  // delivery). Internal-only email needs no SMTP at all — it is delivered
  // immediately; external parts go through the ONE EmailService queue.
  const allAddresses = [...new Set([...to, ...cc, ...bcc])].map((a) => a.toLowerCase());
  const orgMailboxes = allAddresses.length
    ? await db.mailbox.findMany({ where: { email: { in: allAddresses }, isActive: true }, select: { id: true, email: true } })
    : [];
  const orgMailboxByEmail = new Map(orgMailboxes.map((m) => [m.email.toLowerCase(), m.id] as const));
  const staffAddresses = allAddresses.filter((a) => !orgMailboxByEmail.has(a));
  const staffUsers = staffAddresses.length
    ? await db.user.findMany({
        where: { email: { in: staffAddresses }, role: { not: "CUSTOMER" }, status: "ACTIVE" },
        select: { id: true, email: true, name: true },
      })
    : [];
  const staffByEmail = new Map(staffUsers.map((u) => [u.email.toLowerCase(), u] as const));
  const isInternal = (a: string) => orgMailboxByEmail.has(a.toLowerCase()) || staffByEmail.has(a.toLowerCase());
  const externalTo = to.filter((a) => !isInternal(a));
  const externalCc = cc.filter((a) => !isInternal(a));
  const externalBcc = bcc.filter((a) => !isInternal(a));
  const externalCount = externalTo.length + externalCc.length + externalBcc.length;
  const threadRoot = message.threadId || message.id;

  // Move the message into the delivery pipeline. All-internal sends are
  // DELIVERED immediately (folder SENT, real INBOX copies below); mixed or
  // external sends stay OUTBOX/QUEUED until the worker's SMTP outcome lands.
  await db.mailMessage.update({
    where: { id: message.id },
    data: externalCount > 0
      ? { folder: "OUTBOX", status: "QUEUED", lastError: "" }
      : { folder: "SENT", status: "SENT", sentAt: new Date(), lastError: "" },
  });

  let emailLogId = "";
  if (externalCount > 0) {
    const result = await queueClientEmail({
      mailMessageId: message.id,
      to: externalTo, cc: externalCc, bcc: externalBcc,
      subject: subject || "(no subject)",
      html: message.bodyHtml,
      text: message.bodyText,
      sender: { fromName: mailbox.displayName || "MOHD.HMS Enterprise", fromEmail: mailbox.email, replyTo: mailbox.email },
      attachments: materialized,
    });
    if (!result.ok) {
      // Honest failure — the message is kept, marked FAILED, retryable (§12/§49).
      await db.mailMessage.update({ where: { id: message.id }, data: { status: "FAILED", lastError: result.reason ?? "send rejected" } }).catch(() => undefined);
      throw Errors.badRequest(result.reason ?? "The email could not be queued for delivery.");
    }
    emailLogId = result.id ?? "";
  }

  // Internal INBOX copies — real delivery into colleagues'/shared mailboxes.
  let internalDelivered = 0;
  const seenMailboxes = new Set<string>([mailbox.id]); // never copy into the sending mailbox
  for (const addr of allAddresses) {
    const directBox = orgMailboxByEmail.get(addr) ?? null;
    const staffUser = staffByEmail.get(addr) ?? null;
    const targetBoxId = directBox ?? (staffUser ? await inboxTargetMailbox(staffUser) : null);
    if (!targetBoxId || seenMailboxes.has(targetBoxId)) continue;
    seenMailboxes.add(targetBoxId);
    const copy = await db.mailMessage.create({
      data: {
        mailboxId: targetBoxId, folder: "INBOX", status: "SENT", direction: "IN",
        threadId: threadRoot, subject,
        bodyText: body, bodyHtml: message.bodyHtml,
        fromEmail: mailbox.email, fromName: mailbox.displayName,
        // BCC privacy — received copies never reveal BCC recipients.
        toEmail: [...to, ...cc].join(", "), ccEmail: cc.join(", "), bccEmail: "",
        messageId: "",
      },
      select: { id: true },
    });
    if (attachments.length > 0) {
      await db.mailAttachment.createMany({
        data: attachments.map((a) => ({
          messageId: copy.id, filename: a.filename, contentType: a.contentType,
          sizeBytes: a.sizeBytes, objectKey: a.objectKey, fileId: a.fileId,
        })),
      });
    }
    internalDelivered += 1;
  }

  await audit({
    actorId: user.id, actorEmail: user.email, action: "MAIL_SENT", resourceType: "MAIL_MESSAGE", resourceId: message.id,
    metadata: { from: mailbox.email, recipients: [...to, ...cc, ...bcc].length, internalDelivered, externalQueued: externalCount, subject: (subject || "(no subject)").slice(0, 120), attachments: materialized.length, emailLogId },
  });

  return { messageId: message.id, status: externalCount > 0 ? "QUEUED" : "SENT", emailLogId, internalDelivered, externalQueued: externalCount };
}

/** Requeue a FAILED client email through the existing EmailService retry. */
export async function retryMessage(user: { id: string; email: string }, messageId: string) {
  const message = await accessibleMessage(user.id, messageId);
  if (!["OUTBOX", "SENT"].includes(message.folder)) throw Errors.badRequest("Only Outbox emails can be retried.");
  const logs = await db.emailLog.findMany({ where: { relatedType: "MAIL_MESSAGE", relatedId: messageId }, select: { id: true, status: true } });
  if (logs.length === 0) throw Errors.badRequest("This email has no delivery record to retry.");
  let any = false;
  for (const log of logs) {
    if (log.status === "SENT") continue; // never duplicate a delivered email
    const r = await retryEmail(log.id);
    if (r.ok) any = true;
  }
  if (any) {
    await db.mailMessage.updateMany({ where: { id: messageId }, data: { status: "QUEUED", lastError: "" } });
    await audit({ actorId: user.id, actorEmail: user.email, action: "MAIL_RETRY", resourceType: "MAIL_MESSAGE", resourceId: messageId });
  }
  return { ok: any };
}

// ─── Message access (§44 — every operation validates the full chain) ────────

async function accessibleMessage(userId: string, messageId: string) {
  const message = await db.mailMessage.findUnique({ where: { id: messageId } });
  if (!message) throw Errors.notFound("Email not found.");
  // The mailbox gate IS the ownership check — never trust a browser mailbox id.
  const ids = await readableMailboxIds(userId);
  if (!ids.includes(message.mailboxId)) throw Errors.notFound("Email not found.");
  return message;
}

// ─── Listing + search (§21 — server-side, scoped to readable mailboxes) ─────

export type ListParams = {
  folder?: string;
  q?: string;
  flag?: string; // unread | starred | hasAttachment
  from?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
};

export async function listMessages(userId: string, params: ListParams) {
  const ids = await readableMailboxIds(userId);
  const empty = { messages: [] as unknown[], total: 0, page: 1, pageSize: MAIL_PAGE_SIZE, unreadByFolder: await unreadCounts(userId), starred: 0, important: 0 };
  if (ids.length === 0) return empty;

  const q = params.q?.trim();
  const folder = (params.folder ?? "").toUpperCase();
  const where: Prisma.MailMessageWhereInput = { mailboxId: { in: ids } };
  if (folder === "STARRED") where.starredAt = { not: null };
  else if (folder === "IMPORTANT") where.important = true;
  else if (folder && (MAIL_FOLDERS as readonly string[]).includes(folder)) where.folder = folder;
  else if (!q) where.folder = "INBOX";
  // A search WITHOUT an explicit folder runs across every folder (global
  // search-mail semantics, §21); the client passes the folder for scoped views.

  if (params.flag === "unread") where.readAt = null;
  if (params.flag === "starred") where.starredAt = { not: null };
  if (params.flag === "hasAttachment") where.attachments = { some: {} };
  if (params.flag === "important") where.important = true;

  if (params.from?.trim()) where.fromEmail = { contains: params.from.trim().toLowerCase() };
  if (params.dateFrom || params.dateTo) {
    where.createdAt = {};
    if (params.dateFrom && !Number.isNaN(Date.parse(params.dateFrom))) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(params.dateFrom);
    if (params.dateTo && !Number.isNaN(Date.parse(params.dateTo))) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(`${params.dateTo}T23:59:59.999Z`);
  }
  if (q) {
    const like = { contains: q.slice(0, 120) };
    where.OR = [
      { subject: like },
      { bodyText: like },
      { bodyHtml: like },
      { fromEmail: like },
      { fromName: like },
      { toEmail: like },
      { ccEmail: like },
    ];
  }

  const page = Math.max(1, Math.min(500, Math.floor(Number(params.page) || 1)));
  const [total, messages, starred, important] = await Promise.all([
    db.mailMessage.count({ where }),
    db.mailMessage.findMany({
      where,
      select: LIST_SELECT,
      orderBy: { createdAt: "desc" },
      take: MAIL_PAGE_SIZE,
      skip: (page - 1) * MAIL_PAGE_SIZE,
    }),
    db.mailMessage.count({ where: { mailboxId: { in: ids }, starredAt: { not: null } } }),
    db.mailMessage.count({ where: { mailboxId: { in: ids }, important: true } }),
  ]);

  // Delivery truth for Outbox rows comes from the authoritative EmailLog rows.
  const outboxIds = messages.filter((m) => m.folder === "OUTBOX").map((m) => m.id);
  const delivery = new Map<string, { attempts: number; lastError: string }>();
  if (outboxIds.length > 0) {
    const logs = await db.emailLog.findMany({
      where: { relatedType: "MAIL_MESSAGE", relatedId: { in: outboxIds } },
      select: { relatedId: true, attemptCount: true, lastError: true, scheduledAt: true },
      orderBy: { scheduledAt: "desc" },
    });
    for (const log of logs) {
      const prev = delivery.get(log.relatedId);
      delivery.set(log.relatedId, {
        attempts: Math.max(prev?.attempts ?? 0, log.attemptCount),
        lastError: log.lastError || prev?.lastError || "",
      });
    }
  }

  return {
    messages: messages.map((m) => serializeList(m, delivery.get(m.id))),
    total, page, pageSize: MAIL_PAGE_SIZE,
    unreadByFolder: await unreadCounts(userId),
    starred, important,
  };
}

async function unreadCounts(userId: string): Promise<Record<string, number>> {
  const ids = await readableMailboxIds(userId);
  const out: Record<string, number> = { INBOX: 0, SENT: 0, DRAFTS: 0, OUTBOX: 0, ARCHIVE: 0, SPAM: 0, TRASH: 0, STARRED: 0, IMPORTANT: 0 };
  if (ids.length === 0) return out;
  const groups = await db.mailMessage.groupBy({
    by: ["folder"],
    where: { mailboxId: { in: ids }, folder: { in: ["INBOX"] }, readAt: null },
    _count: { _all: true },
  });
  for (const grp of groups) out[grp.folder] = grp._count._all;
  // Drafts/Outbox counts are total items (action needed), not unread.
  const counts = await db.mailMessage.groupBy({
    by: ["folder"],
    where: { mailboxId: { in: ids }, folder: { in: ["DRAFTS", "OUTBOX"] } },
    _count: { _all: true },
  });
  for (const grp of counts) out[grp.folder] = grp._count._all;
  return out;
}

type DeliveryInfo = { attempts: number; lastError: string } | undefined;

function serializeList(m: ListMessage, delivery?: DeliveryInfo) {
  const displayStatus = m.folder === "OUTBOX" && m.status === "QUEUED" && (delivery?.attempts ?? 0) > 0 ? "RETRYING" : m.status;
  return {
    id: m.id, mailboxId: m.mailboxId, folder: m.folder, status: displayStatus, direction: m.direction,
    threadId: m.threadId, subject: m.subject, fromName: m.fromName, fromEmail: m.fromEmail,
    toEmail: m.toEmail, ccEmail: m.ccEmail,
    preview: (m.bodyText || "").replace(/\s+/g, " ").trim().slice(0, 140),
    readAt: m.readAt?.toISOString() ?? null,
    starred: Boolean(m.starredAt), important: m.important,
    sentAt: m.sentAt?.toISOString() ?? null,
    hasAttachments: m._count.attachments > 0,
    createdAt: m.createdAt.toISOString(),
    lastError: delivery?.lastError ?? m.lastError ?? "",
    attempts: delivery?.attempts ?? 0,
  };
}

// ─── Detail + thread (§15/§22) ──────────────────────────────────────────────

export async function getMessage(userId: string, messageId: string) {
  const message = await accessibleMessage(userId, messageId);
  const [attachments, thread] = await Promise.all([
    db.mailAttachment.findMany({ where: { messageId }, orderBy: { createdAt: "asc" } }),
    accessibleMessageThread(userId, message),
  ]);
  return {
    id: message.id, mailboxId: message.mailboxId, folder: message.folder, status: message.status,
    direction: message.direction, threadId: message.threadId,
    subject: message.subject, fromName: message.fromName, fromEmail: message.fromEmail,
    toEmail: message.toEmail, ccEmail: message.ccEmail, bccEmail: message.bccEmail,
    bodyHtml: message.bodyHtml, bodyText: message.bodyText,
    readAt: message.readAt?.toISOString() ?? null,
    starred: Boolean(message.starredAt), important: message.important,
    sentAt: message.sentAt?.toISOString() ?? null, lastError: message.lastError,
    messageId: message.messageId, createdAt: message.createdAt.toISOString(),
    attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes })),
    thread: thread.map((t) => ({
      id: t.id, subject: t.subject, fromName: t.fromName, fromEmail: t.fromEmail,
      createdAt: t.createdAt.toISOString(), preview: (t.bodyText || "").replace(/\s+/g, " ").trim().slice(0, 120),
      isCurrent: t.id === messageId,
    })),
  };
}

async function accessibleMessageThread(userId: string, message: { threadId: string; id: string }) {
  const ids = await readableMailboxIds(userId);
  if (ids.length === 0) return [];
  const threadId = message.threadId || message.id;
  return db.mailMessage.findMany({
    where: { mailboxId: { in: ids }, OR: [{ threadId }, { id: threadId }] },
    select: { id: true, subject: true, fromName: true, fromEmail: true, bodyText: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
}

// ─── Actions (§8/§23/§24/§25/§26/§27 — persisted server-side state) ─────────

export type MessageAction =
  | "read" | "unread" | "star" | "unstar" | "important" | "normal"
  | "archive" | "spam" | "trash" | "restore" | "move";

export async function actOnMessage(user: { id: string; email: string }, messageId: string, action: MessageAction, targetFolder?: string) {
  const message = await accessibleMessage(user.id, messageId);
  const data: Record<string, unknown> = {};
  let auditAction = "";

  switch (action) {
    case "read":
      data.readAt = new Date();
      break;
    case "unread":
      data.readAt = null;
      break;
    case "star":
      data.starredAt = new Date();
      break;
    case "unstar":
      data.starredAt = null;
      break;
    case "important":
      data.important = true;
      break;
    case "normal":
      data.important = false;
      break;
    case "archive":
      if (message.folder === "DRAFTS") throw Errors.badRequest("Drafts cannot be archived.");
      data.folder = "ARCHIVE";
      auditAction = "MAIL_MOVED";
      break;
    case "spam":
      if (message.folder === "DRAFTS") throw Errors.badRequest("Drafts cannot be marked as spam.");
      data.folder = "SPAM";
      auditAction = "MAIL_MOVED";
      break;
    case "trash":
      if (message.folder === "DRAFTS") { await deleteDraft(user, messageId); return { ok: true }; }
      if (message.folder === "TRASH") return { ok: true };
      data.folder = "TRASH";
      auditAction = "MAIL_TRASHED";
      break;
    case "restore": {
      if (message.status === "DRAFT") data.folder = "DRAFTS";
      else if (message.direction === "IN") data.folder = "INBOX";
      else if (message.status === "SENT") data.folder = "SENT";
      else data.folder = "OUTBOX";
      auditAction = "MAIL_RESTORED";
      break;
    }
    case "move": {
      const target = String(targetFolder ?? "").toUpperCase();
      if (!(["INBOX", "ARCHIVE", "SPAM", "TRASH", "SENT", "OUTBOX"].includes(target))) throw Errors.badRequest("Invalid destination folder.");
      if (message.folder === "DRAFTS" || message.status === "DRAFT") throw Errors.badRequest("Drafts cannot be moved.");
      if (target !== "TRASH" && message.folder === "TRASH") throw Errors.badRequest("Restore the email before moving it.");
      if (target === "INBOX") data.folder = message.direction === "IN" ? "INBOX" : (message.status === "SENT" ? "SENT" : "OUTBOX");
      else data.folder = target;
      auditAction = "MAIL_MOVED";
      break;
    }
    default:
      throw Errors.badRequest("Unknown action.");
  }

  await db.mailMessage.update({ where: { id: message.id }, data });
  if (auditAction) {
    await audit({ actorId: user.id, actorEmail: user.email, action: auditAction, resourceType: "MAIL_MESSAGE", resourceId: message.id, metadata: { action, folder: String(data.folder ?? message.folder) } });
  }
  return { ok: true };
}

export async function deleteMessage(user: { id: string; email: string }, messageId: string, permanent: boolean) {
  const message = await accessibleMessage(user.id, messageId);
  if (message.status === "DRAFT") { await deleteDraft(user, messageId); return { ok: true, permanent: true }; }
  if (!permanent && message.folder !== "TRASH") {
    await db.mailMessage.update({ where: { id: message.id }, data: { folder: "TRASH" } });
    await audit({ actorId: user.id, actorEmail: user.email, action: "MAIL_TRASHED", resourceType: "MAIL_MESSAGE", resourceId: message.id, metadata: { action: "delete" } });
    return { ok: true, permanent: false };
  }
  if (!permanent && message.folder === "TRASH") permanent = true; // deleting inside Trash = permanent
  if (message.folder !== "TRASH" && permanent) throw Errors.badRequest("Only emails in Trash can be permanently deleted.");
  // Remove mail-owned objects (best effort) — drafts' FileEntry objects are the
  // user's own Files and are NOT removed here.
  const attachments = await db.mailAttachment.findMany({ where: { messageId }, select: { objectKey: true, fileId: true } });
  for (const att of attachments) {
    if (!att.fileId && att.objectKey.startsWith(`mail/messages/${message.id}/`)) {
      await storage.remove(att.objectKey).catch(() => undefined);
    }
  }
  await db.mailMessage.delete({ where: { id: message.id } });
  await audit({ actorId: user.id, actorEmail: user.email, action: "MAIL_PERMANENTLY_DELETED", resourceType: "MAIL_MESSAGE", resourceId: message.id, metadata: { subject: message.subject.slice(0, 120) } });
  return { ok: true, permanent: true };
}

// ─── Reply / Reply-All / Forward context (§16/§17/§18) ──────────────────────

export type ComposePrefill = {
  mode: "reply" | "replyAll" | "forward";
  mailboxId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  originalId: string;
};

export async function composePrefill(userId: string, mode: "reply" | "replyAll" | "forward", originalId: string): Promise<ComposePrefill> {
  const orig = await accessibleMessage(userId, originalId);
  const mailboxes = await myMailboxes(userId);
  const mine = new Set(mailboxes.map((m) => m.email.toLowerCase()));
  // Replies to our own sent mail go back to its recipients, not to ourselves.
  const counterpart = orig.direction === "OUT" ? orig.toEmail : orig.fromEmail;
  const preferred =
    mailboxes.find((m) => m.canSend && m.email.toLowerCase() === (orig.direction === "OUT" ? orig.fromEmail : orig.toEmail).split(",")[0]?.trim().toLowerCase())
    ?? mailboxes.find((m) => m.canSend);
  if (!preferred) throw Errors.forbidden("You have no mailbox you can send from. Ask an administrator to assign one.");
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter((s) => s && !mine.has(s.toLowerCase()));

  if (mode === "forward") {
    return {
      mode, mailboxId: preferred.id,
      to: [], cc: [],
      subject: forwardSubject(orig.subject),
      body: `\n\n---------- Forwarded message ----------\nFrom: ${orig.fromName || orig.fromEmail} <${orig.fromEmail}>\nDate: ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(orig.createdAt)}\nSubject: ${orig.subject}\n\n${orig.bodyText}`,
      originalId: orig.id,
    };
  }

  // Reply / Reply-All — BCC is NEVER carried over (§17).
  const to = mode === "replyAll" ? [...list(counterpart), ...list(orig.toEmail)] : list(counterpart);
  const cc = mode === "replyAll" ? list(orig.ccEmail) : [];
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(orig.createdAt);
  const author = orig.direction === "OUT" ? (list(orig.toEmail)[0] ?? orig.toEmail) : (orig.fromName || orig.fromEmail);
  const quoted = orig.bodyText
    ? `\n\nOn ${date}, ${author} wrote:\n${orig.bodyText.split("\n").map((l) => `> ${l}`).join("\n")}`
    : "\n\n";
  return {
    mode, mailboxId: preferred.id,
    to: [...new Set(to)], cc: [...new Set(cc)],
    subject: replySubject(orig.subject),
    body: quoted,
    originalId: orig.id,
  };
}

/** Attach forward attachments (copies of the original's attachments) onto a draft. */
export async function cloneAttachmentsForForward(userId: string, fromMessageId: string, toDraftId: string): Promise<number> {
  const orig = await accessibleMessage(userId, fromMessageId);
  const draft = await accessibleMessage(userId, toDraftId);
  if (draft.folder !== "DRAFTS" || draft.status !== "DRAFT") throw Errors.badRequest("Attachments can only be added to drafts.");
  const sources = await db.mailAttachment.findMany({ where: { messageId: orig.id } });
  let total = (await db.mailAttachment.aggregate({ where: { messageId: draft.id }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;
  let cloned = 0;
  for (const src of sources) {
    if (total + src.sizeBytes > MAIL_MAX_TOTAL_ATTACHMENT_BYTES) break;
    await db.mailAttachment.create({
      data: { messageId: draft.id, filename: src.filename, contentType: src.contentType, sizeBytes: src.sizeBytes, objectKey: src.objectKey, fileId: "" },
    });
    total += src.sizeBytes;
    cloned++;
  }
  return cloned;
}

// ─── Upload (§19 — MinIO via the Files pipeline; §20 Files integration) ─────

export async function uploadComposeAttachment(user: { id: string; email: string }, file: { name: string; buffer: Buffer; mimeType: string }) {
  // The attachment becomes a real File in the user's Files space (§20).
  assertRolePermission(user, PERMISSIONS.files_create);
  if (file.buffer.length === 0) throw Errors.badRequest("The file is empty.");
  if (file.buffer.length > MAIL_MAX_ATTACHMENT_BYTES) {
    throw Errors.badRequest(`Files are limited to ${Math.round(MAIL_MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB per attachment.`);
  }
  await assertQuota(user.id, file.buffer.length);
  const name = sanitizeFileName(file.name);
  const contentType = sniffMimeType(file.buffer, name);

  // Find-or-create the user's "Email Attachments" folder.
  let folder = await db.fileFolder.findFirst({ where: { ownerId: user.id, name: "Email Attachments", parentId: null }, select: { id: true } });
  if (!folder) {
    folder = await db.fileFolder.create({ data: { ownerId: user.id, name: "Email Attachments" }, select: { id: true } });
  }

  const key = `mail/uploads/${user.id}/${randomUUID()}.${extOf(name)}`;
  const checksum = sha256(file.buffer);
  await storage.put(key, file.buffer, contentType);
  const entry = await db.fileEntry.create({
    data: {
      ownerId: user.id, folderId: folder.id, name, mimeType: contentType,
      sizeBytes: file.buffer.length, checksum, objectKey: key,
    },
  });
  await audit({ actorId: user.id, actorEmail: user.email, action: "MAIL_ATTACHMENT_UPLOADED", resourceType: "FILE", resourceId: entry.id, metadata: { name, sizeBytes: file.buffer.length } });
  return { fileId: entry.id, filename: entry.name, contentType: entry.mimeType, sizeBytes: entry.sizeBytes };
}

/** Authorized attachment download (§19 — stream through the API, never public MinIO). */
export async function readAttachment(userId: string, messageId: string, attachmentId: string) {
  await accessibleMessage(userId, messageId); // mailbox gate
  const att = await db.mailAttachment.findFirst({ where: { id: attachmentId, messageId } });
  if (!att) throw Errors.notFound("Attachment not found.");
  const obj = await storage.get(att.objectKey);
  if (!obj) throw Errors.notFound("Attachment file is no longer available in storage.");
  return { filename: att.filename, contentType: att.contentType || obj.contentType, buffer: obj.buffer };
}

// ─── Recipient suggestions (§11) ────────────────────────────────────────────

export async function recipientSuggestions(user: { id: string; role: string }, q: string) {
  const query = q.trim().slice(0, 80);
  if (!query) return { users: [], customers: [], mailboxes: [], groups: [], corporateEmails: [] };
  const like = { contains: query };
  const qLower = query.toLowerCase();
  const [users, corporateDirectory, myMailboxList, customers] = await Promise.all([
    db.user.findMany({
      where: { status: "ACTIVE", role: { not: "CUSTOMER" }, OR: [{ name: like }, { email: like }] },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
      take: 8,
    }),
    // Corporate-address directory search (email provisioning spec §22/§34):
    // a query may match a colleague's CORPORATE address or display name — the
    // result is merged into the staff suggestions below (never a second identity).
    db.mailbox.findMany({
      where: { kind: "PERSONAL", isActive: true, ownerUserId: { not: null } },
      select: { email: true, displayName: true, owner: { select: { id: true, email: true, name: true, role: true } } },
      take: 200,
    }).then((rows) =>
      rows.filter((r) =>
        r.owner?.role !== "CUSTOMER" &&
        (r.email.toLowerCase().includes(qLower) || r.displayName.toLowerCase().includes(qLower) || (r.owner?.name.toLowerCase().includes(qLower) ?? false))
      ).slice(0, 8)
    ),
    myMailboxes(user.id),
    roleCan(user.role, PERMISSIONS.customers_read)
      ? db.customer.findMany({
          where: { OR: [{ companyName: like }, { contactPerson: like }, { email: like }] },
          select: { id: true, companyName: true, contactPerson: true, email: true },
          take: 5,
        })
      : Promise.resolve([] as { id: string; companyName: string; contactPerson: string; email: string }[]),
  ]);
  // Merge corporate-directory hits into the staff user list (deduped by id) so
  // compose suggests the colleague ONCE with their authoritative sign-in
  // identity; the corporate address travels alongside as directory metadata.
  const byId = new Map<string, { id: string; name: string; email: string; role: string; corporateEmail?: string }>();
  for (const u of users) byId.set(u.id, { ...u });
  for (const hit of corporateDirectory) {
    const owner = hit.owner!;
    const existing = byId.get(owner.id);
    if (existing) existing.corporateEmail = hit.email;
    else byId.set(owner.id, { id: owner.id, name: owner.name, email: owner.email, role: owner.role, corporateEmail: hit.email });
  }
  const mergedUsers = [...byId.values()];
  return {
    users: mergedUsers.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
    // Corporate email directory hits (§22) — consumers may offer
    // name <corporate@mohdhms.com> completions; sign-in identity is preserved.
    corporateEmails: mergedUsers
      .filter((u) => u.corporateEmail)
      .map((u) => ({ id: u.id, name: u.name, email: u.corporateEmail!, role: u.role })),
    mailboxes: myMailboxList.map((m) => ({ id: m.id, name: m.displayName || m.email, email: m.email })),
    customers: customers
      .filter((c) => Boolean(c.email))
      .map((c) => ({ id: c.id, name: c.companyName || c.contactPerson, email: c.email })),
    // Contact groups (distribution lists) matching the query — the compose UI
    // inserts ALL member addresses when one is selected.
    groups: await db.mailContactGroup
      .findMany({ where: { name: like }, orderBy: { name: "asc" }, take: 3 })
      .then((rows) =>
        rows.map((g) => ({
          id: g.id,
          name: g.name,
          count: parseGroupMembers(g.members).length,
          members: parseGroupMembers(g.members),
        }))
      ),
  };
}

// ─── Mailbox administration (Email Configuration module — email.config RBAC) ──

export type MailboxAdminInput = {
  email?: string;
  displayName?: string;
  description?: string;
  kind?: string;
  ownerUserId?: string | null;
  isActive?: boolean;
};

function assertValidMailboxEmail(email: string): string {
  const addr = email.trim();
  if (!isValidEmail(addr)) throw Errors.badRequest(`"${addr.slice(0, 60)}" is not a valid mailbox address.`);
  return addr.toLowerCase();
}

export async function adminListMailboxes() {
  const rows = await db.mailbox.findMany({
    include: {
      owner: { select: { id: true, name: true, email: true } },
      members: { select: { id: true, userId: true, canSend: true, user: { select: { id: true, name: true, email: true, role: true } } }, orderBy: { createdAt: "asc" } },
      _count: { select: { messages: true } },
    },
    orderBy: [{ kind: "asc" }, { email: "asc" }],
  });
  return rows.map((m) => ({
    id: m.id, email: m.email, displayName: m.displayName, description: m.description,
    kind: m.kind, isActive: m.isActive, messageCount: m._count.messages,
    owner: m.owner, members: m.members,
    createdAt: m.createdAt.toISOString(),
  }));
}

export async function adminCreateMailbox(actor: { id: string; email: string }, input: MailboxAdminInput) {
  if (!input.email) throw Errors.badRequest("A mailbox address is required.");
  const email = assertValidMailboxEmail(input.email);
  const kind = input.kind === "SHARED" ? "SHARED" : "PERSONAL";
  const ownerUserId = kind === "PERSONAL" ? (input.ownerUserId || null) : null;
  if (kind === "PERSONAL" && ownerUserId) {
    const owner = await db.user.findUnique({ where: { id: ownerUserId }, select: { id: true } });
    if (!owner) throw Errors.badRequest("The mailbox owner user does not exist.");
  }
  const exists = await db.mailbox.findUnique({ where: { email }, select: { id: true } });
  if (exists) throw Errors.conflict("A mailbox with this address already exists.");
  const mailbox = await db.mailbox.create({
    data: {
      email, kind, ownerUserId,
      displayName: (input.displayName ?? "").slice(0, 120),
      description: (input.description ?? "").slice(0, 300),
      isActive: input.isActive ?? true,
      members: ownerUserId ? { create: { userId: ownerUserId, canSend: true } } : undefined,
    },
  });
  await audit({ actorId: actor.id, actorEmail: actor.email, action: "MAILBOX_CREATED", resourceType: "MAILBOX", resourceId: mailbox.id, metadata: { email, kind } });
  return { id: mailbox.id };
}

export async function adminUpdateMailbox(actor: { id: string; email: string }, mailboxId: string, input: MailboxAdminInput) {
  const mailbox = await db.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw Errors.notFound("Mailbox not found.");
  const data: Record<string, unknown> = {};
  if (input.email !== undefined) data.email = assertValidMailboxEmail(input.email);
  if (input.displayName !== undefined) data.displayName = input.displayName.slice(0, 120);
  if (input.description !== undefined) data.description = input.description.slice(0, 300);
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.kind !== undefined) {
    const kind = input.kind === "SHARED" ? "SHARED" : "PERSONAL";
    if (kind !== mailbox.kind) {
      data.kind = kind;
      if (kind === "SHARED") data.ownerUserId = null;
    }
  }
  if (input.ownerUserId !== undefined) {
    const ownerUserId = input.ownerUserId || null;
    if (ownerUserId) {
      const owner = await db.user.findUnique({ where: { id: ownerUserId }, select: { id: true } });
      if (!owner) throw Errors.badRequest("The mailbox owner user does not exist.");
    }
    data.ownerUserId = ownerUserId;
    // The owner is always a full member.
    if (ownerUserId) {
      await db.mailboxMember.upsert({
        where: { mailboxId_userId: { mailboxId, userId: ownerUserId } },
        update: { canSend: true },
        create: { mailboxId, userId: ownerUserId, canSend: true },
      });
    }
  }
  await db.mailbox.update({ where: { id: mailboxId }, data });
  await audit({ actorId: actor.id, actorEmail: actor.email, action: "MAILBOX_UPDATED", resourceType: "MAILBOX", resourceId: mailboxId, metadata: { email: mailbox.email } });
  return { id: mailboxId };
}

export async function adminDeleteMailbox(actor: { id: string; email: string }, mailboxId: string) {
  const mailbox = await db.mailbox.findUnique({ where: { id: mailboxId }, include: { _count: { select: { messages: true } } } });
  if (!mailbox) throw Errors.notFound("Mailbox not found.");
  if (mailbox._count.messages > 0) {
    throw Errors.badRequest(`This mailbox still holds ${mailbox._count.messages} message(s). Empty its folders (or permanently delete them) before removing the mailbox.`);
  }
  await db.mailbox.delete({ where: { id: mailboxId } });
  await audit({ actorId: actor.id, actorEmail: actor.email, action: "MAILBOX_DELETED", resourceType: "MAILBOX", resourceId: mailboxId, metadata: { email: mailbox.email } });
}

export async function adminAddMailboxMember(actor: { id: string; email: string }, mailboxId: string, userId: string, canSend: boolean) {
  const mailbox = await db.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw Errors.notFound("Mailbox not found.");
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!user) throw Errors.badRequest("The user does not exist.");
  if (user.role === "CUSTOMER") throw Errors.badRequest("Customers cannot be assigned to internal corporate mailboxes.");
  await db.mailboxMember.upsert({
    where: { mailboxId_userId: { mailboxId, userId } },
    update: { canSend },
    create: { mailboxId, userId, canSend },
  });
  await audit({ actorId: actor.id, actorEmail: actor.email, action: "MAILBOX_MEMBER_ADDED", resourceType: "MAILBOX", resourceId: mailboxId, metadata: { userId, canSend } });
  return { ok: true };
}

export async function adminRemoveMailboxMember(actor: { id: string; email: string }, mailboxId: string, userId: string) {
  const mailbox = await db.mailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw Errors.notFound("Mailbox not found.");
  if (mailbox.ownerUserId === userId) throw Errors.badRequest("The mailbox owner cannot be removed — change the owner instead.");
  await db.mailboxMember.deleteMany({ where: { mailboxId, userId } });
  await audit({ actorId: actor.id, actorEmail: actor.email, action: "MAILBOX_MEMBER_REMOVED", resourceType: "MAILBOX", resourceId: mailboxId, metadata: { userId } });
  return { ok: true };
}

// ─── Bootstrap (§6–§9 — honest client state) ────────────────────────────────

export async function bootstrap(userId: string) {
  const [mailboxes, counts, cfg] = await Promise.all([
    myMailboxes(userId),
    unreadCounts(userId),
    getEmailConfig(),
  ]);
  const starred = mailboxes.length
    ? await db.mailMessage.count({ where: { mailboxId: { in: mailboxes.map((m) => m.id) }, starredAt: { not: null } } })
    : 0;
  const important = mailboxes.length
    ? await db.mailMessage.count({ where: { mailboxId: { in: mailboxes.map((m) => m.id) }, important: true } })
    : 0;
  return {
    mailboxes,
    counts: { ...counts, STARRED: starred, IMPORTANT: important },
    smtp: { configured: Boolean(cfg.smtpHost && (cfg.fromEmail || cfg.smtpUser)) },
    // Honest inbound statement (§8/§29): the existing mail architecture is
    // SMTP-send only; no IMAP/POP3/provider-inbound integration exists, so no
    // fake inbox is created. Incoming support arrives with the first real
    // retrieval integration.
    inbound: {
      supported: false,
      detail: "Incoming email (IMAP) is not part of the current mail architecture — this inbox will fill as soon as inbound retrieval is configured.",
    },
  };
}
