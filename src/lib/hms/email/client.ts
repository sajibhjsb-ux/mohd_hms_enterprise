// MOHD.HMS ENTERPRISE — Email client core (professional mailbox).
// Shared server-side logic for /api/v1/email/client/* routes. ONE mailbox
// store (MailMessage), ONE delivery pipeline (the existing EmailService
// worker + EmailLog) — this module never talks SMTP itself and never stores
// attachment bytes (MinIO via the centralized storage service).

import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { storage } from "@/lib/hms/storage";

// ─── Folders ────────────────────────────────────────────────────────────────

export const MAIL_FOLDERS = ["INBOX", "SENT", "DRAFT", "OUTBOX", "ARCHIVE", "SPAM", "TRASH"] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

export function isMailFolder(v: string): v is MailFolder {
  return (MAIL_FOLDERS as readonly string[]).includes(v);
}

/** Folder moves allowed per direction — backend-authoritative (§ RBAC). */
export function canMoveTo(direction: string, current: string, target: MailFolder, status: string): { ok: boolean; reason?: string } {
  if (current === target) return { ok: false, reason: "already there" };
  if (direction === "DRAFT" || current === "DRAFT") {
    // Drafts: stay a draft or go to trash (permanent delete via DELETE).
    if (target === "TRASH") return { ok: true };
    return { ok: false, reason: "drafts can only be deleted" };
  }
  if (direction === "OUT") {
    // A queued/sending message must be canceled before it can be moved —
    // otherwise the worker sync (scoped to OUTBOX) would lose track of it.
    if (current === "OUTBOX" && (status === "QUEUED" || status === "SENDING")) {
      return { ok: false, reason: "cancel the delivery before moving a queued email" };
    }
    if (target === "SENT" || target === "OUTBOX" || target === "ARCHIVE" || target === "TRASH") return { ok: true };
    return { ok: false, reason: "invalid folder for a sent email" };
  }
  // IN
  if (target === "INBOX" || target === "ARCHIVE" || target === "SPAM" || target === "TRASH") return { ok: true };
  return { ok: false, reason: "invalid folder for a received email" };
}

// ─── Attachments (references only — bytes live in MinIO) ────────────────────

export type MailAttachmentRef = { id: string; key: string; filename: string; size: number; contentType: string };

export function parseAttachmentRefs(raw: string): MailAttachmentRef[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (a): a is MailAttachmentRef =>
        Boolean(a) && typeof a === "object" &&
        typeof (a as MailAttachmentRef).id === "string" &&
        typeof (a as MailAttachmentRef).key === "string"
    );
  } catch {
    return [];
  }
}

/** Defensive display-name sanitizer (paths, control chars, length cap). */
export function sanitizeFilename(name: string): string {
  const base = String(name ?? "").split(/[/\\]/).pop() ?? "attachment";
  return base.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 120) || "attachment";
}

/** Server-generated MinIO key under the uploader's OWN prefix — client
 * filenames never become object keys (same policy as avatars/photos). */
export function buildAttachmentKey(userId: string, filename: string): string {
  const extMatch = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : ".bin";
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `mail/${userId}/${rand}${ext}`;
}

/** A ref can enter a message only if its object was uploaded by THIS user. */
export function isOwnAttachmentKey(userId: string, key: string): boolean {
  return typeof key === "string" && key.startsWith(`mail/${userId}/`) && !key.includes("..");
}

// ─── Content helpers ────────────────────────────────────────────────────────

export function htmlToExcerpt(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 160);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Normalize + validate a recipient list; returns unique lowercase-addressed entries. */
export function normalizeRecipients(input: unknown, cap: number): { ok: true; list: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "recipients must be a list" };
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of input) {
    const addr = String(raw ?? "").trim().toLowerCase();
    if (!addr) continue;
    if (addr.length > 254 || !EMAIL_RE.test(addr)) return { ok: false, error: `"${String(raw).slice(0, 60)}" is not a valid email address` };
    if (seen.has(addr)) continue;
    seen.add(addr);
    list.push(addr);
    if (list.length > cap) return { ok: false, error: `too many recipients (max ${cap})` };
  }
  return { ok: true, list };
}

// ─── Group members ──────────────────────────────────────────────────────────

export type MailGroupMember = { name: string; email: string };

export const GROUP_COLORS = ["emerald", "amber", "rose", "teal", "orange", "cyan", "lime", "fuchsia"] as const;

/** Zod schema + validator for group writes — shared by the group routes. */
export const mailGroupSchema = z.object({
  name: z.string().trim().min(1, "Group name is required.").max(80),
  color: z.enum(GROUP_COLORS).default("emerald"),
  members: z.array(z.object({ name: z.string().max(80).default(""), email: z.string().max(254) })).max(200).default([]),
});

export function parseGroupMembers(raw: string): MailGroupMember[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((m) => ({ name: String((m as MailGroupMember)?.name ?? "").slice(0, 80), email: String((m as MailGroupMember)?.email ?? "").toLowerCase() }))
      .filter((m) => EMAIL_RE.test(m.email));
  } catch {
    return [];
  }
}

export function normalizeGroupMembers(input: unknown): { ok: true; list: MailGroupMember[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "members must be a list" };
  const seen = new Set<string>();
  const list: MailGroupMember[] = [];
  for (const raw of input) {
    const m = raw as MailGroupMember;
    const email = String(m?.email ?? "").trim().toLowerCase();
    if (!email) continue;
    if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: `"${email.slice(0, 60)}" is not a valid email address` };
    if (seen.has(email)) continue;
    seen.add(email);
    list.push({ name: String(m?.name ?? "").trim().slice(0, 80), email });
    if (list.length > 200) return { ok: false, error: "a group can hold at most 200 members" };
  }
  return { ok: true, list };
}

// ─── Shared fetchers ────────────────────────────────────────────────────────

/** List-view projection — never includes bodyHtml (kept for the detail view). */
export const MAIL_LIST_SELECT = {
  id: true, folder: true, direction: true, status: true, fromName: true, fromEmail: true,
  toEmail: true, ccEmail: true, subject: true, excerpt: true, readAt: true, starredAt: true,
  threadId: true, emailLogId: true, sentAt: true, failedReason: true, attachmentRefs: true,
  originFolder: true, createdAt: true, updatedAt: true,
} as const;

/** Verify the requester owns a mailbox row (backend-authoritative ownership). */
export async function findOwnedMessage(messageId: string, ownerId: string) {
  return db.mailMessage.findFirst({ where: { id: messageId, ownerId } });
}

/** Best-effort object delete for PERMANENT removes (never blocks the flow). */
export async function removeAttachmentObjects(refs: MailAttachmentRef[]): Promise<void> {
  for (const ref of refs) {
    if (isOwnAttachmentKey("", ref.key) || ref.key.startsWith("mail/")) {
      await storage.remove(ref.key).catch(() => undefined);
    }
  }
}
