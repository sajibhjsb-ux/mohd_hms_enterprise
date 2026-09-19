// MOHD.HMS ENTERPRISE — Letter workflow endpoint (§15/§16/§25/§34/§35/§43).
//
//   POST /api/v1/hr/letters/{id}/workflow   { action, ...payload }
//
//   submit   DRAFT|AI_GENERATED|REJECTED → UNDER_REVIEW     (letters.edit)
//   approve  UNDER_REVIEW → APPROVED         (letters.approve — ADMIN+, §16)
//   reject   UNDER_REVIEW → REJECTED         (letters.approve)
//   reopen   REJECTED → DRAFT                (letters.edit)
//   finalize APPROVED → FINALIZED            (letters.finalize)
//            → renders the FINAL PDF through the central engine and stores it
//              in object storage (letters/{year}/{type}/{id}/final.pdf §23);
//              from this point the letter is immutable (§28)
//   send     FINALIZED|SENT → SENT           (letters.send)
//            → queues delivery through the existing notification EMAIL channel
//              (production provider integration point); only FINALIZED
//              documents are ever sent (§34)
//   share    FINALIZED|SENT → (stays)        (letters.send)
//            → WhatsApp share via the existing WHATSAPP channel log (§35)
//   archive  FINALIZED|SENT → ARCHIVED       (letters.send)
//   unarchive ARCHIVED → SENT               (letters.send) — administrative fix

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { buildLetterPdf, letterPdfKey } from "@/lib/hms/letters/pdf";
import { storage, StorageError } from "@/lib/hms/storage";
import { audit, notify } from "@/lib/hms/services";
import type { Permission } from "@/lib/hms/constants";

const workflowSchema = z.object({
  action: z.enum(["submit", "approve", "reject", "reopen", "finalize", "send", "share", "archive", "unarchive"]),
  // send/share payload (§34)
  to: z.string().email().optional(),
  subject: z.string().max(300).optional(),
  message: z.string().max(4000).optional(),
  // reject payload
  reason: z.string().max(2000).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const body = await parseBody(req, workflowSchema);

    const letter = await db.letter.findUnique({ where: { id } });
    if (!letter) throw Errors.notFound("Letter not found.");

    // ── Permission per action (§42 — backend authoritative) ───────────────
    const permissionFor: Record<string, Permission> = {
      submit: PERMISSIONS.letters_edit,
      reopen: PERMISSIONS.letters_edit,
      approve: PERMISSIONS.letters_approve,
      reject: PERMISSIONS.letters_approve,
      finalize: PERMISSIONS.letters_finalize,
      send: PERMISSIONS.letters_send,
      share: PERMISSIONS.letters_send,
      archive: PERMISSIONS.letters_send,
      unarchive: PERMISSIONS.letters_send,
    };
    if (!roleCan(user.role, permissionFor[body.action])) {
      throw Errors.forbidden();
    }

    const ev = (action: string, detail: string) => ({
      action,
      detail,
      actorId: user.id,
      actorName: user.name,
    });

    // ── submit / reopen / approve / reject ──────────────────────────────────
    if (body.action === "submit" || body.action === "reopen" || body.action === "approve" || body.action === "reject") {
      const from =
        body.action === "submit"
          ? ["DRAFT", "AI_GENERATED", "REJECTED"]
          : body.action === "reopen"
            ? ["REJECTED"]
            : ["UNDER_REVIEW"];
      if (!from.includes(letter.status)) {
        throw Errors.invalidTransition(`Cannot ${body.action} a letter in status ${letter.status}.`);
      }

      if (body.action === "submit") {
        if (!letter.body.trim()) throw Errors.badRequest("The letter body is empty. Complete the draft before submitting for approval.");
        const updated = await db.letter.update({
          where: { id: letter.id },
          data: { status: "UNDER_REVIEW", updatedById: user.id, events: { create: ev("SUBMITTED", "Submitted for approval") } },
        });
        await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_SUBMITTED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber } });
        await notifyRoleAdmins(letter.letterNumber, letter.subject, letter.id);
        return ok({ id: updated.id, status: updated.status });
      }

      if (body.action === "reopen") {
        const updated = await db.letter.update({
          where: { id: letter.id },
          data: { status: "DRAFT", updatedById: user.id, events: { create: ev("EDITED", "Reopened as draft") } },
        });
        return ok({ id: updated.id, status: updated.status });
      }

      if (body.action === "approve") {
        const updated = await db.letter.update({
          where: { id: letter.id },
          data: {
            status: "APPROVED",
            approvedById: user.id,
            approvedByName: user.name,
            approvedAt: new Date(),
            updatedById: user.id,
            events: { create: ev("APPROVED", "Approved") },
          },
        });
        await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_APPROVED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber, approvedBy: user.name } });
        return ok({ id: updated.id, status: updated.status, approvedByName: updated.approvedByName });
      }

      // reject
      const updated = await db.letter.update({
        where: { id: letter.id },
        data: {
          status: "REJECTED",
          updatedById: user.id,
          events: { create: ev("REJECTED", body.reason ? `Rejected — ${body.reason.slice(0, 300)}` : "Rejected") },
        },
      });
      await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_REJECTED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber, reason: body.reason?.slice(0, 300) ?? "" } });
      return ok({ id: updated.id, status: updated.status });
    }

    // ── finalize (§25/§28): render → validate → store → metadata ────────────
    if (body.action === "finalize") {
      if (letter.status !== "APPROVED") {
        throw Errors.invalidTransition(`Only APPROVED letters can be finalized (current status: ${letter.status}).`);
      }
      if (!letter.signatoryName.trim() || !letter.signatoryPosition.trim()) {
        throw Errors.badRequest("Signatory name and position are required before finalizing.");
      }

      // Reload with attachments so the PDF includes the enclosures list.
      const full = await db.letter.findUniqueOrThrow({ where: { id: letter.id } });
      const { bytes, filename } = await buildLetterPdf(full);
      if (!(bytes instanceof Uint8Array) || bytes.length < 500 || new TextDecoder("latin1").decode(bytes.slice(0, 5)) !== "%PDF-") {
        throw Errors.internal("The generated PDF failed validation. Nothing was finalized — please try again.");
      }

      const key = letterPdfKey(full);
      try {
        await storage.put(key, Buffer.from(bytes), "application/pdf");
      } catch (e) {
        if (e instanceof StorageError) {
          throw Errors.internal("Object storage is unavailable — the letter was NOT finalized. Please try again.");
        }
        throw e;
      }

      const updated = await db.letter.update({
        where: { id: letter.id },
        data: {
          status: "FINALIZED",
          pdfObjectKey: key,
          pdfSizeBytes: bytes.length,
          finalizedAt: new Date(),
          updatedById: user.id,
          events: { create: ev("FINALIZED", `Final PDF generated (${(bytes.length / 1024).toFixed(1)} KB) and stored`) },
        },
      });
      await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_FINALIZED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber, pdfKey: key, sizeBytes: bytes.length, filename } });
      return ok({ id: updated.id, status: updated.status, hasPdf: true, sizeBytes: bytes.length });
    }

    // ── send (§34) ──────────────────────────────────────────────────────────
    if (body.action === "send") {
      if (!["FINALIZED", "SENT"].includes(letter.status)) {
        throw Errors.invalidTransition("Only finalized letters can be sent. Draft AI content is never emailed as final (§34).");
      }
      if (!letter.pdfObjectKey) throw Errors.internal("The finalized PDF is missing from storage. Please re-finalize via support.");
      const to = body.to?.trim();
      if (!to) throw Errors.badRequest("A recipient email address is required to send the letter.");

      const updated = await db.letter.update({
        where: { id: letter.id },
        data: {
          status: letter.status === "SENT" ? letter.status : "SENT",
          sentAt: letter.sentAt ?? new Date(),
          updatedById: user.id,
          events: { create: ev("SENT", `Email queued to ${to}`) },
        },
      });
      // Existing notification EMAIL channel — delivery is queued/logged here
      // and delivered by the configured provider in production (§34).
      await notify({
        userId: user.id,
        title: `Letter ${letter.letterNumber} sent`,
        message: `Letter ${letter.letterNumber} was queued for delivery to ${to}. Subject: ${body.subject ?? letter.subject}`,
        type: "INFO",
        resourceType: "LETTER",
        resourceId: letter.id,
        channels: ["IN_APP", "EMAIL"],
      });
      await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_SENT", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber, to, subject: body.subject ?? letter.subject } });
      return ok({ id: updated.id, status: updated.status, sentTo: to });
    }

    // ── share (WhatsApp, §35) ───────────────────────────────────────────────
    if (body.action === "share") {
      if (!["FINALIZED", "SENT"].includes(letter.status)) {
        throw Errors.invalidTransition("Only finalized letters can be shared.");
      }
      await db.letterEvent.create({
        data: { letterId: letter.id, action: "SHARED", detail: "Shared via WhatsApp (existing channel)", actorId: user.id, actorName: user.name },
      });
      await notify({
        userId: user.id,
        title: `Letter ${letter.letterNumber} shared`,
        message: `Letter ${letter.letterNumber} was shared via the WhatsApp channel.`,
        type: "INFO",
        resourceType: "LETTER",
        resourceId: letter.id,
        channels: ["WHATSAPP"],
      });
      await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_SHARED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber, channel: "WHATSAPP" } });
      return ok({ id: letter.id, shared: true });
    }

    // ── archive / unarchive ─────────────────────────────────────────────────
    if (body.action === "archive") {
      if (!["FINALIZED", "SENT"].includes(letter.status)) {
        throw Errors.invalidTransition("Only finalized or sent letters are archived.");
      }
      const updated = await db.letter.update({
        where: { id: letter.id },
        data: { status: "ARCHIVED", updatedById: user.id, events: { create: ev("ARCHIVED", "Archived") } },
      });
      await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_ARCHIVED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber } });
      return ok({ id: updated.id, status: updated.status });
    }

    // unarchive — administrative correction back to SENT.
    if (letter.status !== "ARCHIVED") throw Errors.invalidTransition("Only archived letters can be unarchived.");
    const updated = await db.letter.update({
      where: { id: letter.id },
      data: { status: "SENT", updatedById: user.id, events: { create: ev("EDITED", "Unarchived back to SENT") } },
    });
    return ok({ id: updated.id, status: updated.status });
  },
  { permission: PERMISSIONS.letters_view } // per-action permission enforced inline above
);

/** Notify admins (approvers) that a letter is awaiting review (§16). */
async function notifyRoleAdmins(letterNumber: string, subject: string, letterId: string) {
  const admins = await db.user.findMany({ where: { role: { in: ["ADMIN", "SUPER_ADMIN"] }, status: "ACTIVE" }, select: { id: true } });
  for (const a of admins) {
    await notify({
      userId: a.id,
      title: "Letter awaiting approval",
      message: `Letter ${letterNumber} — "${subject.slice(0, 80)}" was submitted for approval.`,
      type: "INFO",
      resourceType: "LETTER",
      resourceId: letterId,
    });
  }
}
