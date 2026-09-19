// MOHD.HMS ENTERPRISE — Letter attachments (§33).
//
//   POST   /api/v1/hr/letters/{id}/attachments          — upload (multipart)
//   DELETE /api/v1/hr/letters/{id}/attachments?attachmentId={id} — remove
//   GET    /api/v1/hr/letters/{id}/attachments?attachmentId={id} — download
//
// Files live in S3/MinIO under letters/{year}/{type}/{id}/attachments/;
// the DB stores metadata only. Finalized letters accept no new attachments
// (the issued PDF already lists its enclosures, §28).

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage } from "@/lib/hms/storage";
import { audit } from "@/lib/hms/services";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXT = new Set(["pdf", "png", "jpg", "jpeg", "webp", "doc", "docx", "xls", "xlsx", "csv", "txt"]);
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
};

const NON_EDITABLE = new Set(["FINALIZED", "SENT", "ARCHIVED"]);

async function loadLetter(id: string) {
  const letter = await db.letter.findUnique({ where: { id } });
  if (!letter) throw Errors.notFound("Letter not found.");
  return letter;
}

function idFromPath(req: Request): string {
  return new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
}

export const POST = handler(
  async ({ req, user }) => {
    const letter = await loadLetter(idFromPath(req));
    if (NON_EDITABLE.has(letter.status)) {
      throw Errors.invalidTransition("Finalized letters are immutable — attachments can no longer be added.");
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw Errors.badRequest("No file was provided.");

    if (file.size === 0) throw Errors.badRequest("The file is empty.");
    if (file.size > MAX_BYTES) throw Errors.badRequest("Attachment is too large. Maximum allowed size is 10 MB.");

    // Extension decides the MIME — client-declared types are not trusted.
    const rawName = (file.name || "attachment").replace(/[^\w.\- ()]/g, "_").slice(0, 120);
    const ext = (rawName.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      throw Errors.badRequest(`Unsupported file type ".${ext}". Allowed: ${[...ALLOWED_EXT].join(", ")}.`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0) throw Errors.badRequest("The file could not be read. Please try again.");

    const attachmentId = randomUUID();
    const objectKey = `letters/${letter.createdAt.getFullYear()}/${letter.letterType}/${letter.id}/attachments/${attachmentId}.${ext}`;

    try {
      await storage.put(objectKey, buffer, MIME_BY_EXT[ext] ?? "application/octet-stream");
    } catch {
      throw Errors.internal("Object storage is unavailable — the attachment was not saved. Please try again.");
    }

    const row = await db.letterAttachment.create({
      data: {
        letterId: letter.id,
        name: rawName,
        objectKey,
        sizeBytes: buffer.length,
        mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
        uploadedById: user.id,
      },
    });
    await db.letterEvent.create({
      data: { letterId: letter.id, action: "ATTACHMENT_ADDED", detail: `Added "${rawName}"`, actorId: user.id, actorName: user.name },
    });
    await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_ATTACHMENT_ADDED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber, name: rawName, sizeBytes: buffer.length } });

    return ok({ id: row.id, name: row.name, sizeBytes: row.sizeBytes, mimeType: row.mimeType, createdAt: row.createdAt.toISOString() }, 201);
  },
  { permission: PERMISSIONS.letters_edit }
);

export const GET = handler(
  async ({ req, user }) => {
    const letter = await loadLetter(idFromPath(req));
    const attachmentId = new URL(req.url).searchParams.get("attachmentId") ?? "";
    const att = await db.letterAttachment.findUnique({ where: { id: attachmentId } });
    if (!att || att.letterId !== letter.id) throw Errors.notFound("Attachment not found.");

    const obj = await storage.get(att.objectKey);
    if (!obj) throw Errors.notFound("The attachment file could not be found in storage.");

    await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_ATTACHMENT_DOWNLOADED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber, attachmentId: att.id } });
    return new NextResponse(new Uint8Array(obj.buffer), {
      status: 200,
      headers: {
        "Content-Type": att.mimeType || "application/octet-stream",
        "Content-Length": String(obj.buffer.length),
        "Content-Disposition": `attachment; filename="${att.name.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  },
  { permission: PERMISSIONS.letters_view }
);

export const DELETE = handler(
  async ({ req, user }) => {
    const letter = await loadLetter(idFromPath(req));
    if (NON_EDITABLE.has(letter.status)) {
      throw Errors.invalidTransition("Finalized letters are immutable — attachments can no longer be removed.");
    }
    const attachmentId = new URL(req.url).searchParams.get("attachmentId") ?? "";
    const att = await db.letterAttachment.findUnique({ where: { id: attachmentId } });
    if (!att || att.letterId !== letter.id) throw Errors.notFound("Attachment not found.");

    await db.letterAttachment.delete({ where: { id: att.id } });
    await storage.remove(att.objectKey);
    await db.letterEvent.create({
      data: { letterId: letter.id, action: "ATTACHMENT_REMOVED", detail: `Removed "${att.name}"`, actorId: user.id, actorName: user.name },
    });
    await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_ATTACHMENT_REMOVED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber, attachmentId: att.id } });
    return ok({ deleted: true });
  },
  { permission: PERMISSIONS.letters_edit }
);
