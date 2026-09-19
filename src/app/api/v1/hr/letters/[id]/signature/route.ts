// MOHD.HMS ENTERPRISE — Letter signature image (§22).
//
//   POST /api/v1/hr/letters/{id}/signature — upload PNG/JPG signature (≤ 2 MB)
//   GET  /api/v1/hr/letters/{id}/signature — stream it (RBAC-checked)
//
// The image lives in S3/MinIO (letters/{year}/{type}/{id}/signature.{ext}) —
// never as binary in the database (§22).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage } from "@/lib/hms/storage";
import { audit } from "@/lib/hms/services";

export const runtime = "nodejs";

const MAX_BYTES = 2 * 1024 * 1024;
const NON_EDITABLE = new Set(["FINALIZED", "SENT", "ARCHIVED"]);

/** Magic-byte sniffing — the bytes decide, not the declared MIME. */
function sniffImage(buf: Buffer): "png" | "jpg" | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  return null;
}

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
      throw Errors.invalidTransition("Finalized letters are immutable — the signature can no longer be changed.");
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw Errors.badRequest("No signature image was provided.");
    if (file.size === 0) throw Errors.badRequest("The image is empty.");
    if (file.size > MAX_BYTES) throw Errors.badRequest("Signature image is too large. Maximum allowed size is 2 MB.");

    const buffer = Buffer.from(await file.arrayBuffer());
    const kind = sniffImage(buffer);
    if (!kind) throw Errors.badRequest("The signature must be a PNG or JPG image. On iPhone, set the camera to JPEG or pick the image from Files.");

    // Remove the previous signature object (single signature per letter).
    if (letter.signatorySignatureKey) await storage.remove(letter.signatorySignatureKey);

    const objectKey = `letters/${letter.createdAt.getFullYear()}/${letter.letterType}/${letter.id}/signature.${kind}`;
    try {
      await storage.put(objectKey, buffer, kind === "png" ? "image/png" : "image/jpeg");
    } catch {
      throw Errors.internal("Object storage is unavailable — the signature was not saved. Please try again.");
    }

    await db.letter.update({ where: { id: letter.id }, data: { signatorySignatureKey: objectKey, updatedById: user.id } });
    await db.letterEvent.create({
      data: { letterId: letter.id, action: "SIGNATURE_SET", detail: "Signature image updated", actorId: user.id, actorName: user.name },
    });
    await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_SIGNATURE_SET", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber } });

    return ok({ saved: true });
  },
  { permission: PERMISSIONS.letters_edit }
);

export const GET = handler(
  async ({ req }) => {
    const letter = await loadLetter(idFromPath(req));
    if (!letter.signatorySignatureKey) throw Errors.notFound("No signature image on this letter.");
    const obj = await storage.get(letter.signatorySignatureKey);
    if (!obj) throw Errors.notFound("The signature image could not be found in storage.");
    return new NextResponse(new Uint8Array(obj.buffer), {
      status: 200,
      headers: {
        "Content-Type": obj.contentType,
        "Content-Length": String(obj.buffer.length),
        "Cache-Control": "private, no-store",
      },
    });
  },
  { permission: PERMISSIONS.letters_view }
);

export const DELETE = handler(
  async ({ req, user }) => {
    const letter = await loadLetter(idFromPath(req));
    if (NON_EDITABLE.has(letter.status)) throw Errors.invalidTransition("Finalized letters are immutable.");
    if (letter.signatorySignatureKey) await storage.remove(letter.signatorySignatureKey);
    await db.letter.update({ where: { id: letter.id }, data: { signatorySignatureKey: "", updatedById: user.id } });
    await audit({ actorId: user.id, actorEmail: user.email, action: "LETTER_SIGNATURE_REMOVED", resourceType: "LETTER", resourceId: letter.id, metadata: { letterNumber: letter.letterNumber } });
    return ok({ deleted: true });
  },
  { permission: PERMISSIONS.letters_edit }
);
