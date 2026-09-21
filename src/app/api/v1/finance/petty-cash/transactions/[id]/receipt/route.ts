// MOHD.HMS ENTERPRISE — Petty cash receipt upload/download (spec §38).
//
//   POST /api/v1/finance/petty-cash/transactions/{id}/receipt — multipart upload (replace while PENDING)
//   GET  /api/v1/finance/petty-cash/transactions/{id}/receipt — authorized byte stream
//
// Files live in MinIO under finance/petty-cash/{fundId}/{txId}/{uuid}.{ext};
// the DB stores a metadata snapshot only. Upload is allowed while the
// transaction is PENDING (by finance managers or the transaction's creator);
// the client-declared MIME type is never trusted — magic bytes decide.

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage } from "@/lib/hms/storage";
import { audit } from "@/lib/hms/services";
import { roleCan } from "@/lib/hms/rbac";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

async function loadTx(id: string) {
  const tx = await db.pettyCashTransaction.findUnique({
    where: { id },
    include: { fund: { select: { id: true, code: true, name: true } } },
  });
  if (!tx) throw Errors.notFound("Petty cash transaction not found.");
  return tx;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ req, user }) => {
    const tx = await loadTx(id);

    const canManage = roleCan(user.role, PERMISSIONS.finance_manage);
    const isCreator = tx.createdById === user.id;
    if (!canManage && !isCreator) {
      throw Errors.forbidden("Only the submitter or a finance manager can attach a receipt.");
    }
    if (tx.status !== "PENDING") {
      throw Errors.invalidTransition("Receipts can only be attached while the transaction is pending.");
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw Errors.badRequest("No file was provided.");

    if (file.size === 0) throw Errors.badRequest("The file is empty.");
    if (file.size > MAX_BYTES) throw Errors.badRequest("Receipt is too large. Maximum allowed size is 10 MB.");

    const rawName = (file.name || "receipt").replace(/[^\w.\- ()]/g, "_").slice(0, 120);
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0) throw Errors.badRequest("The file could not be read. Please try again.");

    // Magic-byte sniffing (§36) — decide the true type from the content, then
    // require the extension to agree (pdf/jpg/jpeg/png only).
    const sniffed = sniffReceiptMime(buffer);
    if (!sniffed) {
      throw Errors.badRequest("Unsupported receipt type. Allowed: PDF, JPG or PNG.");
    }
    const ext: string = EXT_BY_MIME[sniffed] ?? "";
    if (!ext) {
      throw Errors.badRequest("Unsupported receipt type. Allowed: PDF, JPG or PNG.");
    }
    const nameExt = (rawName.split(".").pop() ?? "").toLowerCase();
    if (!["pdf", "jpg", "jpeg", "png"].includes(nameExt)) {
      throw Errors.badRequest(`File extension ".${nameExt}" does not match an allowed receipt type. Allowed: pdf, jpg, jpeg, png.`);
    }
    if ((nameExt === "jpg" || nameExt === "jpeg") && ext !== "jpg") {
      throw Errors.badRequest("File content does not match its extension — the upload was rejected.");
    }
    if (nameExt === "pdf" && ext !== "pdf") {
      throw Errors.badRequest("File content does not match its extension — the upload was rejected.");
    }
    if (nameExt === "png" && ext !== "png") {
      throw Errors.badRequest("File content does not match its extension — the upload was rejected.");
    }

    const previousKey = tx.receiptObjectKey;
    const objectKey = `finance/petty-cash/${tx.fundId}/${tx.id}/${randomUUID()}.${ext}`;
    try {
      await storage.put(objectKey, buffer, sniffed);
    } catch {
      throw Errors.internal("Object storage is unavailable — the receipt was not saved. Please try again.");
    }

    const updated = await db.pettyCashTransaction.update({
      where: { id: tx.id },
      data: {
        receiptObjectKey: objectKey,
        receiptName: rawName,
        receiptMimeType: sniffed,
        receiptSizeBytes: buffer.length,
      },
    });

    // Replacement: drop the superseded object (best-effort).
    if (previousKey && previousKey !== objectKey) await storage.remove(previousKey);

    await audit({
      actorId: user.id, actorEmail: user.email, action: "PETTY_CASH_RECEIPT_ATTACHED",
      resourceType: "PETTY_CASH_TRANSACTION", resourceId: tx.id,
      metadata: { code: tx.code, name: rawName, sizeBytes: buffer.length, mimeType: sniffed, replaced: Boolean(previousKey) },
    });

    return ok({
      receiptName: updated.receiptName,
      receiptMimeType: updated.receiptMimeType,
      receiptSizeBytes: updated.receiptSizeBytes,
    }, 201);
  }, { auth: true })(req);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ req, user }) => {
    const tx = await loadTx(id);
    const canRead = roleCan(user.role, PERMISSIONS.finance_read) || tx.createdById === user.id;
    if (!canRead) throw Errors.forbidden();
    if (!tx.receiptObjectKey) throw Errors.notFound("No receipt has been attached to this transaction.");

    const obj = await storage.get(tx.receiptObjectKey);
    if (!obj) throw Errors.notFound("The receipt file could not be found in storage.");

    await audit({
      actorId: user.id, actorEmail: user.email, action: "PETTY_CASH_RECEIPT_DOWNLOADED",
      resourceType: "PETTY_CASH_TRANSACTION", resourceId: tx.id,
      metadata: { code: tx.code, receiptName: tx.receiptName },
    });

    return new NextResponse(new Uint8Array(obj.buffer), {
      status: 200,
      headers: {
        "Content-Type": tx.receiptMimeType || obj.contentType || "application/octet-stream",
        "Content-Length": String(obj.buffer.length),
        "Content-Disposition": `attachment; filename="${(tx.receiptName || "receipt").replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }, { auth: true })(req);
}

/** Minimal magic-byte sniff for the three allowed receipt families. */
function sniffReceiptMime(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.length >= 3 && buf.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  return null;
}
