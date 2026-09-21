// MOHD.HMS ENTERPRISE — Email attachment resolution (§21/§22/§63/§64).
// Attachments are resolved through AUTHORIZED APPLICATION ENTITIES only — an
// automation can never attach an arbitrary MinIO object key. PDFs are produced
// by the ONE central PDF engine (buildDocument) or retrieved from MinIO (final
// letters); bytes are streamed from memory, never copied to a local disk.

import "server-only";
import { db } from "@/lib/db";
import { buildDocument, findDocumentType } from "@/lib/hms/pdf/documents";
import { storage, StorageError } from "@/lib/hms/storage";
import type { AttachmentKind, AttachmentSpec, ResolvedAttachment } from "./types";

/** System PDF identity — internal document builds (authorized, staff-level). */
const SYSTEM_PDF_USER = { id: "system", role: "ADMIN", customerId: null };

const KIND_TO_DOC: Partial<Record<AttachmentKind, string>> = {
  INVOICE_PDF: "invoice",
  QUOTATION_PDF: "quotation",
  WO_PDF: "work-order",
  INSPECTION_PDF: "inspection-report",
  PAYMENT_RECEIPT_PDF: "payment-receipt",
};

/**
 * Resolve every attachment spec for an email. A spec that cannot be resolved
 * (missing entity, missing object) is returned as an error — the caller decides
 * whether to send without the attachment (never silently) or fail the job.
 */
export async function resolveAttachments(specs: AttachmentSpec[], ctx: { resourceType: string; resourceId: string }): Promise<{ attachments: ResolvedAttachment[]; errors: string[] }> {
  const attachments: ResolvedAttachment[] = [];
  const errors: string[] = [];

  for (const spec of specs) {
    try {
      const resolved = await resolveOne(spec, ctx);
      if (resolved) attachments.push(resolved);
      else errors.push(`${spec.kind}: related document could not be resolved.`);
    } catch (e) {
      const detail = e instanceof StorageError ? e.message : e instanceof Error ? e.message : String(e);
      errors.push(`${spec.kind}: ${detail}`);
    }
  }
  return { attachments, errors };
}

async function resolveOne(spec: AttachmentSpec, ctx: { resourceType: string; resourceId: string }): Promise<ResolvedAttachment | null> {
  // ── Email client attachments: validated MinIO refs under mail/{userId}/ ──
  // The key is generated SERVER-SIDE at upload time and can only enter a
  // message through the send endpoint, which re-verifies the uploader prefix.
  if (spec.kind === "MAIL_FILE") {
    const mailSpec = spec as import("./types").MailFileSpec;
    const key = typeof mailSpec.key === "string" ? mailSpec.key : "";
    if (!key.startsWith("mail/") || key.includes("..")) return null;
    const obj = await storage.get(key);
    if (!obj) return null;
    return {
      kind: spec.kind,
      filename: mailSpec.filename || "attachment",
      buffer: obj.buffer,
      contentType: mailSpec.contentType || obj.contentType,
      ref: `mail:${key}`,
    };
  }

  // ── HR letters: the finalized PDF lives in MinIO (immutable, §49) ──
  if (spec.kind === "LETTER_PDF") {
    const letterId = ctx.resourceType === "LETTER" ? ctx.resourceId : null;
    if (!letterId) return null;
    const letter = await db.letter.findUnique({ where: { id: letterId }, select: { letterNumber: true, pdfObjectKey: true, finalizedAt: true } });
    if (!letter?.pdfObjectKey || !letter.finalizedAt) return null;
    const obj = await storage.get(letter.pdfObjectKey);
    if (!obj) return null;
    return {
      kind: spec.kind,
      filename: `${letter.letterNumber}.pdf`,
      buffer: obj.buffer,
      contentType: "application/pdf",
      ref: `letter:${letterId}:${letter.pdfObjectKey}`,
    };
  }

  // ── Payment receipt: the event points at the invoice — resolve latest payment ──
  if (spec.kind === "PAYMENT_RECEIPT_PDF") {
    if (ctx.resourceType !== "INVOICE") return null;
    const pay = await db.payment.findFirst({ where: { invoiceId: ctx.resourceId }, orderBy: { paidAt: "desc" }, select: { id: true } });
    if (!pay) return null;
    return buildFromEngine("payment-receipt", pay.id, `receipt-${pay.id}.pdf`);
  }

  // ── Entity PDFs via the central engine ──
  const docType = KIND_TO_DOC[spec.kind];
  if (!docType) return null;
  // The event's resourceId IS the entity (COMPLAINT events point at complaints,
  // INVOICE events at invoices…). No other id source is ever accepted (§22).
  return buildFromEngine(docType, ctx.resourceId);
}

async function buildFromEngine(docType: string, entityId: string, forceName?: string): Promise<ResolvedAttachment | null> {
  const def = findDocumentType(docType);
  if (!def) return null;
  // Verify the entity actually exists before generating (no phantom attachments).
  const exists = await entityExists(docType, entityId);
  if (!exists) return null;
  const built = await buildDocument(def, entityId, SYSTEM_PDF_USER);
  return {
    kind: (Object.keys(KIND_TO_DOC).find((k) => KIND_TO_DOC[k as AttachmentKind] === docType) ?? "INVOICE_PDF") as AttachmentKind,
    filename: forceName ?? built.filename,
    buffer: Buffer.from(built.bytes),
    contentType: "application/pdf",
    ref: `pdf-engine:${docType}:${entityId}`,
  };
}

async function entityExists(docType: string, id: string): Promise<boolean> {
  switch (docType) {
    case "invoice": return Boolean(await db.invoice.findUnique({ where: { id }, select: { id: true } }));
    case "quotation": return Boolean(await db.quotation.findUnique({ where: { id }, select: { id: true } }));
    case "work-order": return Boolean(await db.workOrder.findUnique({ where: { id }, select: { id: true } }));
    case "inspection-report": return Boolean(await db.inspectionReport.findUnique({ where: { id }, select: { id: true } }));
    case "payment-receipt": return Boolean(await db.payment.findUnique({ where: { id }, select: { id: true } }));
    default: return false;
  }
}
