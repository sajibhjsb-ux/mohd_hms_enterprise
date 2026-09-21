// MOHD.HMS ENTERPRISE — Customer payment-proof submission (spec §20-§26).
//
//   POST /api/v1/invoices/{id}/payments/proof   (multipart form)
//
// The customer uploads a bank-transfer proof (PDF/JPG/PNG) for their own
// invoice. The payment is recorded with status ON_HOLD — the invoice is NEVER
// treated as paid here (spec §26): only Finance confirmation moves money.
// An automated amount check compares the submitted amount against the
// outstanding balance (no OCR capability exists in the app — the deterministic
// comparison is the automated check per spec §24) and stores MATCHED/MISMATCH.
//
// Object storage: MinIO under payments/{invoiceId}/{paymentId}/proof-*. —
// the DB stores metadata snapshots only. Upload failure ⇒ payment row is
// deleted (no partial data, spec §44).

import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { audit, nextNumber, notify, notifyRole } from "@/lib/hms/services";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";
import { formatCurrency, toCents } from "@/lib/hms/format";
import { storage } from "@/lib/hms/storage";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PROOF_METHODS = ["BANK_TRANSFER", "BIBD", "BAIDURI"] as const;
const ALLOWED_EXT = new Set(["pdf", "jpg", "jpeg", "png"]);
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};
const PAYABLE_STATUSES = ["SENT", "PARTIALLY_PAID", "OVERDUE"];

const formSchema = z.object({
  amount: z.coerce.number().positive("Payment amount must be greater than 0"),
  method: z.enum(PROOF_METHODS),
  paidAt: z.string().optional(),
  bank: z.string().trim().max(120).optional(),
  reference: z.string().trim().min(3, "Transaction reference is required (min 3 characters)"),
  note: z.string().trim().max(500).optional(),
});

/** Magic-byte sniff (bytes are the truth — client-declared types are not trusted). */
function sniffProofMime(buf: Buffer): { mime: string; ext: string } | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (buf.toString("ascii", 0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  return null;
}

function sanitizeFilename(raw: string): string {
  const base = (raw.split(/[/\\]/).pop() ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (base || "payment-proof").slice(0, 200);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const invoice = await db.invoice.findUnique({
      where: { id },
      select: { id: true, code: true, customerId: true, status: true, balanceCents: true, customer: { select: { portalUser: { select: { id: true } } } } },
    });
    if (!invoice) throw Errors.notFound("Invoice not found.");

    // §21 — ONLY the customer's own portal user (or SUPER_ADMIN/ADMIN) may
    // submit a proof. Everyone else (supervisors, technicians, other
    // customers) is forbidden.
    const isOwnCustomer = !!user.customerId && user.customerId === invoice.customerId;
    const isPrivileged = user.role === "SUPER_ADMIN" || user.role === "ADMIN";
    if (!isOwnCustomer && !isPrivileged) throw Errors.forbidden();

    // ── Invoice guards ──
    if (!PAYABLE_STATUSES.includes(invoice.status)) {
      throw Errors.invalidTransition(`Payment proofs can only be submitted while an invoice is SENT, PARTIALLY_PAID or OVERDUE (current: ${invoice.status}).`);
    }
    if (invoice.balanceCents <= 0) throw Errors.conflict("This invoice is already fully paid.");

    // ── Multipart parsing + validation ──
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw Errors.badRequest("Expected a multipart form upload.");
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) {
      throw Errors.badRequest("No payment proof file was uploaded (field name: file).");
    }
    if (file.size > MAX_BYTES) throw Errors.badRequest("The proof file is too large. Maximum allowed size is 10 MB.");

    const fields: Record<string, string> = {};
    for (const key of ["amount", "method", "paidAt", "bank", "reference", "note"]) {
      const v = form.get(key);
      if (typeof v === "string") fields[key] = v;
    }
    const body = formSchema.parse(fields);
    dedupeSubmission({
      userId: user.id,
      route: `POST /api/v1/invoices/${id}/payments/proof`,
      body: { ...body, fileName: file.name, fileSize: file.size },
    });

    const amountCents = toCents(body.amount);
    // §21 — 0 < amount <= outstanding balance (exact integer cents).
    if (amountCents <= 0) throw Errors.badRequest("The payment amount must be greater than 0.");
    if (amountCents > invoice.balanceCents) {
      throw Errors.badRequest(`The payment amount exceeds the outstanding balance of ${formatCurrency(invoice.balanceCents / 100)}.`);
    }

    const rawName = sanitizeFilename(file.name);
    const ext = (rawName.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      throw Errors.badRequest(`Unsupported proof type ".${ext}". Allowed: PDF, JPG, PNG.`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0) throw Errors.badRequest("The file could not be read. Please try again.");
    if (buffer.length > MAX_BYTES) throw Errors.badRequest("The proof file is too large. Maximum allowed size is 10 MB.");
    const sniffed = sniffProofMime(buffer);
    if (!sniffed) {
      throw Errors.badRequest("The file content is not a valid PDF, JPG or PNG. Please upload the actual bank proof document.");
    }

    // ── Automated amount check (spec §24): deterministic comparison — no OCR
    // exists in the app, so `detectedCents` stays null (never fabricated).
    const result = amountCents === invoice.balanceCents ? "MATCHED" : "MISMATCH";
    const verification = JSON.stringify({
      submittedCents: amountCents,
      outstandingCents: invoice.balanceCents,
      detectedCents: null,
      result,
    });

    const payCode = await nextNumber("PAY");
    const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();

    // Row FIRST (status ON_HOLD), then upload; upload failure ⇒ delete the row
    // (no partial data — spec §44). The invoice is NOT touched here (§26).
    const payment = await db.payment.create({
      data: {
        code: payCode,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        amountCents,
        method: body.method,
        reference: body.reference,
        paidAt,
        note: body.note ?? "",
        status: "ON_HOLD",
        bank: body.bank ?? "",
        proofName: rawName,
        proofMimeType: sniffed.mime,
        proofSizeBytes: buffer.length,
        submittedById: user.id,
        verification,
      },
    });

    const objectKey = `payments/${invoice.id}/${payment.id}/proof-${randomUUID()}.${sniffed.ext}`;
    try {
      await storage.put(objectKey, buffer, sniffed.mime);
      await db.payment.update({ where: { id: payment.id }, data: { proofObjectKey: objectKey } });
    } catch (err) {
      await db.payment.delete({ where: { id: payment.id } }).catch(() => {});
      if (err instanceof Error && err.name === "StorageError") {
        throw Errors.internal("Object storage is unavailable — the payment proof was not saved. Please try again.");
      }
      throw Errors.internal("The payment proof could not be stored. No payment was recorded — please try again.");
    }

    await audit({
      actorId: user.id, actorEmail: user.email, action: "PAYMENT_PROOF_SUBMITTED",
      resourceType: "INVOICE", resourceId: invoice.id,
      metadata: { paymentCode: payCode, amountCents, method: body.method, result },
    });
    await notify({
      userId: user.id,
      title: "Payment proof received",
      message: "Payment proof received. Your payment is awaiting Finance confirmation.",
      type: "INFO",
      resourceType: "INVOICE",
      resourceId: invoice.id,
    });
    if (invoice.customer.portalUser?.id && invoice.customer.portalUser.id !== user.id) {
      await notify({
        userId: invoice.customer.portalUser.id,
        title: "Payment proof received",
        message: "Payment proof received. Your payment is awaiting Finance confirmation.",
        type: "INFO",
        resourceType: "INVOICE",
        resourceId: invoice.id,
      });
    }
    await notifyRole("FINANCE", {
      title: "New payment proof requires review",
      message: `New payment proof requires review: invoice ${invoice.code}, ${formatCurrency(amountCents / 100)} (${body.method}), reference ${body.reference} — automated check: ${result === "MATCHED" ? "amount matched" : "AMOUNT MISMATCH"}.`,
      type: result === "MATCHED" ? "INFO" : "WARNING",
      resourceType: "INVOICE",
      resourceId: invoice.id,
      priority: result === "MATCHED" ? "NORMAL" : "HIGH",
    });

    return ok({
      payment: {
        id: payment.id,
        code: payment.code,
        invoiceId: invoice.id,
        amountCents,
        method: payment.method,
        status: payment.status,
        bank: payment.bank,
        reference: payment.reference,
        paidAt: payment.paidAt,
        proofName: rawName,
        proofMimeType: sniffed.mime,
        proofSizeBytes: buffer.length,
        verification,
      },
    }, 201);
  })(req);
}
