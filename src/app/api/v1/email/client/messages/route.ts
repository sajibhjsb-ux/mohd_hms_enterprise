// MOHD.HMS ENTERPRISE — Email client messages (professional mailbox).
//
// GET  /api/v1/email/client/messages?folder=&starred=&q=&page=&pageSize=
//      Server-side search + pagination over the signed-in user's mailbox.
//      Never returns bodyHtml (list projection only).
//
// POST /api/v1/email/client/messages   { action: "send" | "draft", … }
//      send : validate → deliver internal copies (INBOX) → queue external
//             delivery through the ONE EmailService (EmailLog → worker →
//             SMTP). Internal recipients are matched by User email and are
//             excluded from the SMTP envelope (they already hold a mailbox
//             copy — no double delivery). Sender identity comes from the
//             approved EmailConfig — never from the client payload.
//      draft: persist the draft to PostgreSQL (MailMessage DRAFT row).
//
// Authorization: permission email.client + per-row ownerId scoping. There is
// no client-trusted state: recipients, attachments and identity are all
// re-validated server-side.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { getEmailConfig } from "@/lib/hms/email/config";
import { queueClientEmail } from "@/lib/hms/email/service";
import {
  htmlToExcerpt, isMailFolder, isOwnAttachmentKey, MAIL_LIST_SELECT,
  normalizeRecipients, sanitizeFilename, type MailAttachmentRef,
} from "@/lib/hms/email/client";

const RECIPIENT_CAP = 50;
const ATTACHMENT_CAP = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const composeSchema = z.object({
  action: z.enum(["send", "draft"]),
  draftId: z.string().min(1).max(64).optional(),
  replyToMessageId: z.string().min(1).max(64).optional(),
  to: z.array(z.string()).max(RECIPIENT_CAP + 10).default([]),
  cc: z.array(z.string()).max(RECIPIENT_CAP + 10).default([]),
  bcc: z.array(z.string()).max(RECIPIENT_CAP + 10).default([]),
  subject: z.string().max(500).default(""),
  bodyHtml: z.string().max(512_000).default(""),
  attachments: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        key: z.string().min(1).max(600),
        filename: z.string().max(200),
        size: z.number().int().min(0),
        contentType: z.string().max(150).default("application/octet-stream"),
      })
    )
    .max(ATTACHMENT_CAP)
    .default([]),
});

export const GET = handler(
  async ({ req, user }) => {
    const p = Object.fromEntries(new URL(req.url).searchParams);
    const folder = String(p.folder ?? "INBOX").toUpperCase();
    const starredOnly = p.starred === "1";
    const q = String(p.q ?? "").trim().slice(0, 120);
    const page = Math.max(1, Math.min(10_000, Number(p.page ?? 1) || 1));
    const pageSize = Math.max(1, Math.min(100, Number(p.pageSize ?? 25) || 25));

    if (!starredOnly && !isMailFolder(folder)) throw Errors.badRequest("Unknown folder.");

    const where = {
      ownerId: user.id,
      ...(starredOnly
        ? { starredAt: { not: null }, folder: { notIn: ["TRASH", "SPAM"] } }
        : { folder }),
      ...(q
        ? {
            OR: [
              { subject: { contains: q } },
              { excerpt: { contains: q } },
              { fromName: { contains: q } },
              { fromEmail: { contains: q } },
              { toEmail: { contains: q } },
              { ccEmail: { contains: q } },
            ],
          }
        : {}),
    };

    const [rows, total, unread] = await Promise.all([
      db.mailMessage.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: MAIL_LIST_SELECT,
      }),
      db.mailMessage.count({ where }),
      db.mailMessage.count({
        where: { ownerId: user.id, folder: "INBOX", readAt: null, ...(q ? {} : {}) },
      }),
    ]);

    return okList(rows, { page, pageSize, total, unread, folder: starredOnly ? "STARRED" : folder });
  },
  { permission: PERMISSIONS.email_client }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, composeSchema);

    const to = await normalizeRecipientsOrThrow(body.to);
    const cc = await normalizeRecipientsOrThrow(body.cc);
    const bcc = await normalizeRecipientsOrThrow(body.bcc);

    const subject = body.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 500);
    const bodyHtml = body.bodyHtml;

    // Attachments: only objects uploaded by THIS user (server-generated key
    // prefix binds ownership), display names re-sanitized server-side.
    const attachments: MailAttachmentRef[] = body.attachments.map((a) => {
      if (!isOwnAttachmentKey(user.id, a.key)) throw Errors.forbidden("Attachment does not belong to your uploads.");
      return {
        id: a.id.slice(0, 64),
        key: a.key,
        filename: sanitizeFilename(a.filename),
        size: Math.min(a.size, MAX_ATTACHMENT_BYTES),
        contentType: a.contentType || "application/octet-stream",
      };
    });

    // Optional reply threading — the quoted content is client-side; the
    // linkage is backend-verified ownership.
    let threadId = "";
    let inReplyToId = "";
    if (body.replyToMessageId) {
      const target = await db.mailMessage.findFirst({
        where: { id: body.replyToMessageId, ownerId: user.id },
        select: { id: true, threadId: true },
      });
      if (target) {
        inReplyToId = target.id;
        threadId = target.threadId || target.id;
      }
    }

    // ── Draft save (no delivery) ──────────────────────────────────────────
    if (body.action === "draft") {
      const data = {
        direction: "OUT",
        status: "",
        fromName: user.name,
        fromEmail: user.email,
        toEmail: to.join(", "),
        ccEmail: cc.join(", "),
        bccEmail: bcc.join(", "),
        subject,
        bodyHtml,
        excerpt: htmlToExcerpt(bodyHtml),
        attachmentRefs: JSON.stringify(attachments),
        ...(threadId ? { threadId } : {}),
        ...(inReplyToId ? { inReplyToId } : {}),
      };
      if (body.draftId) {
        const draft = await db.mailMessage.findFirst({
          where: { id: body.draftId, ownerId: user.id, folder: "DRAFT" },
          select: { id: true, threadId: true, inReplyToId: true },
        });
        if (!draft) throw Errors.notFound("Draft not found.");
        const updated = await db.mailMessage.update({
          where: { id: draft.id },
          data: { ...data, threadId: draft.threadId || threadId, inReplyToId: draft.inReplyToId || inReplyToId },
          select: { id: true },
        });
        return ok({ id: updated.id, draft: true });
      }
      const created = await db.mailMessage.create({
        data: { ownerId: user.id, folder: "DRAFT", ...data },
        select: { id: true },
      });
      return ok({ id: created.id, draft: true });
    }

    // ── Send ──────────────────────────────────────────────────────────────
    if (to.length === 0) throw Errors.badRequest("Add at least one recipient.");
    if (!bodyHtml.trim() && attachments.length === 0) {
      throw Errors.badRequest("Write a message or attach a file before sending.");
    }

    const fromName = user.name;
    const replyTo = user.email;

    // Internal recipients get a REAL mailbox copy and are excluded from the
    // SMTP envelope (no double delivery to the same person).
    const all = [...new Set([...to, ...cc, ...bcc])];
    const internalUsers = all.length
      ? await db.user.findMany({
          where: { email: { in: all }, role: { not: "CUSTOMER" }, status: "ACTIVE" },
          select: { id: true, email: true, name: true },
        })
      : [];
    const internal = new Map(internalUsers.map((u) => [u.email.toLowerCase(), u] as const));
    const externalTo = to.filter((a) => !internal.has(a));
    const externalCc = cc.filter((a) => !internal.has(a));
    const externalBcc = bcc.filter((a) => !internal.has(a));
    const internalTargets = internalUsers.filter((u) => u.id !== user.id);

    const externalCount = externalTo.length + externalCc.length + externalBcc.length;

    // Sender identity: internal-only mail carries the author's own identity;
    // external delivery uses ONLY the approved EmailConfig identity (§25) —
    // never a client-supplied one. Internal mail therefore works even before
    // SMTP is configured; external mail requires it.
    let fromEmail = user.email;
    let emailLogId = "";
    let smtpConfigured = true;
    if (externalCount > 0) {
      const cfg = await getEmailConfig();
      const approved = cfg.fromEmail || cfg.smtpUser || "";
      if (!approved) {
        throw Errors.conflict("External delivery needs a configured sending identity. An administrator can finish this in Settings → Email.");
      }
      fromEmail = approved;
      smtpConfigured = Boolean(cfg.smtpHost && (cfg.fromEmail || cfg.smtpUser));
      // Queue external delivery FIRST (single source of delivery truth) so the
      // mailbox row can carry the authoritative EmailLog id.
      const queued = await queueClientEmail({
        to: externalTo,
        cc: externalCc,
        bcc: externalBcc,
        subject,
        html: bodyHtml,
        fromName,
        fromEmail,
        replyTo,
        attachments: attachments.map((a) => ({ filename: a.filename, key: a.key, contentType: a.contentType })),
      });
      if (!queued.ok || !queued.id) {
        throw Errors.internal("The email could not be queued for delivery. Nothing was sent.");
      }
      emailLogId = queued.id;
    }

    const common = {
      direction: "OUT",
      fromName,
      fromEmail,
      toEmail: to.join(", "),
      ccEmail: cc.join(", "),
      bccEmail: bcc.join(", "),
      subject,
      bodyHtml,
      excerpt: htmlToExcerpt(bodyHtml),
      attachmentRefs: JSON.stringify(attachments),
      threadId: threadId || crypto.randomUUID(),
      inReplyToId,
    };

    let messageId: string;

    if (body.draftId) {
      const draft = await db.mailMessage.findFirst({
        where: { id: body.draftId, ownerId: user.id, folder: "DRAFT" },
        select: { id: true, threadId: true, inReplyToId: true },
      });
      if (!draft) throw Errors.notFound("Draft not found.");
      const updated = await db.mailMessage.update({
        where: { id: draft.id },
        data: {
          ...common,
          threadId: draft.threadId || common.threadId,
          inReplyToId: draft.inReplyToId || inReplyToId,
          // All-internal sends are delivered immediately; mixed/external
          // sends start in OUTBOX and move to SENT when SMTP accepts.
          ...(externalCount > 0
            ? { folder: "OUTBOX", status: "QUEUED", emailLogId, readAt: new Date() }
            : { folder: "SENT", status: "SENT", sentAt: new Date(), readAt: new Date() }),
        },
        select: { id: true },
      });
      messageId = updated.id;
    } else {
      const created = await db.mailMessage.create({
        data: {
          ownerId: user.id,
          ...common,
          ...(externalCount > 0
            ? { folder: "OUTBOX", status: "QUEUED", emailLogId, readAt: new Date() }
            : { folder: "SENT", status: "SENT", sentAt: new Date(), readAt: new Date() }),
        },
        select: { id: true },
      });
      messageId = created.id;
    }

    // Internal INBOX copies — real delivery into colleagues' mailboxes.
    if (internalTargets.length > 0) {
      await db.mailMessage.createMany({
        data: internalTargets.map((u) => ({
          ownerId: u.id,
          folder: "INBOX",
          direction: "IN",
          fromName,
          fromEmail: user.email,
          toEmail: to.join(", "),
          ccEmail: cc.join(", "),
          bccEmail: bcc.join(", "),
          subject,
          bodyHtml,
          excerpt: htmlToExcerpt(bodyHtml),
          attachmentRefs: JSON.stringify(attachments),
          threadId: common.threadId,
          inReplyToId,
        })),
      });
    }

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "EMAIL_CLIENT_SENT",
      resourceType: "MAIL_MESSAGE",
      resourceId: messageId,
      metadata: {
        internal: internalTargets.length,
        external: externalCount,
        attachments: attachments.length,
        emailLogId,
        subject: subject.slice(0, 120),
      },
    }).catch(() => undefined);

    return ok({
      id: messageId,
      emailLogId,
      internalDelivered: internalTargets.length,
      externalQueued: externalCount,
      smtpConfigured,
    });
  },
  { permission: PERMISSIONS.email_client }
);

async function normalizeRecipientsOrThrow(input: unknown): Promise<string[]> {
  const res = normalizeRecipients(input, RECIPIENT_CAP);
  if (!res.ok) throw Errors.badRequest(res.error);
  return res.list;
}
