// MOHD.HMS ENTERPRISE — Profile photo (avatar) upload + authenticated serving.
//
// POST /api/v1/profile/avatar  (auth, multipart "file")
//   Self-service photo upload for EVERY authenticated user (spec §11). The
//   image flows through the EXISTING centralized storage pipeline: magic-byte
//   validation (never the client MIME/filename) → sharp normalize → MinIO
//   (private bucket) → PostgreSQL stores the object REFERENCE (User.avatarUrl)
//   → previous object removed. No blobs in the database, no /uploads, no new
//   storage system.
//   Security (spec §12): type by content sniffing (jpg/png/webp only), 5 MB
//   cap, decoder validation, server-generated keys (client filenames never
//   become object keys), bucket stays fully private.
//
// GET /api/v1/profile/avatar[?userId=]  (auth)
//   Serves the avatar through the authenticated API — own photo by default;
//   SUPER_ADMIN may fetch another user's. No public object URLs, ever.
//
// DELETE /api/v1/profile/avatar  (auth)
//   Removes the photo (object + reference) for the signed-in user.

import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { db } from "@/lib/db";
import { handler, ok, Errors, ApiError } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import { assertImageUpload, sniffImageType, UploadValidationError } from "@/lib/hms/irms/storage";
import { storage, StorageError } from "@/lib/hms/storage";

const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — avatars are small (§12)
const AVATAR_SIZE = 512;                   // square cover — circle-friendly

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    ""
  );
}

function failUpload(err: unknown): never {
  if (err instanceof UploadValidationError) throw new ApiError(422, err.code, err.message);
  if (err instanceof StorageError) throw new ApiError(503, err.code, err.message);
  throw err instanceof Error ? err : Errors.badRequest("Upload failed.");
}

/** Content-sniffing that maps validation failures to honest 422 ApiErrors. */
function sniffImageTypeSafe(buf: Buffer) {
  try {
    return sniffImageType(buf);
  } catch (err) {
    failUpload(err);
  }
}

export const POST = handler(async ({ req, user }) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw Errors.badRequest("Expected a multipart form upload.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw Errors.badRequest("No image was uploaded (field name: file).");

  // Size first (own, tighter cap for avatars), then type/structure. Validation
  // helpers throw UploadValidationError — map them to honest ApiErrors.
  if (file.size > AVATAR_MAX_BYTES) {
    throw new ApiError(422, "FILE_TOO_LARGE", "Profile photo is too large. Maximum allowed size is 5 MB.");
  }
  try {
    assertImageUpload(file);
  } catch (err) {
    failUpload(err);
  }

  // Decode + normalize IN MEMORY before anything is persisted (§16) — a
  // corrupt/unsupported image fails here with an honest, specific message.
  const buf = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffImageTypeSafe(buf);
  let avatar: Buffer;
  try {
    avatar = await sharp(buf)
      .rotate() // bake EXIF orientation into the processed image only
      .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: "cover", position: "attention" })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    throw new ApiError(422, "IMAGE_PROCESSING_FAILED", "We could not read this image. Please try another photo.");
  }

  try {
    // Server-generated key (§14) — client filenames never reach the store.
    const key = `avatars/${user.id}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    await storage.put(key, avatar, "image/jpeg");

    const previous = await db.user.findUnique({
      where: { id: user.id },
      select: { avatarUrl: true },
    });

    await db.user.update({ where: { id: user.id }, data: { avatarUrl: key } });

    // Remove the replaced object (best effort — never blocks the new photo).
    if (previous?.avatarUrl) await storage.remove(previous.avatarUrl);

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PROFILE_PHOTO_CHANGED",
      resourceType: "User",
      resourceId: user.id,
      metadata: { scope: "self", key },
      ip: clientIp(req),
    });

    return ok({ avatarUrl: key });
  } catch (err) {
    failUpload(err);
  }
});

export const GET = handler(async ({ req, user }) => {
  const targetId = new URL(req.url).searchParams.get("userId");
  if (targetId && targetId !== user.id) {
    if (user.role !== "SUPER_ADMIN") {
      throw Errors.forbidden("You can only view your own profile photo.");
    }
  }
  const target = await db.user.findUnique({
    where: { id: targetId && targetId !== user.id ? targetId : user.id },
    select: { avatarUrl: true },
  });
  if (!target?.avatarUrl) throw Errors.notFound("No profile photo.");
  const obj = await storage.get(target.avatarUrl);
  if (!obj) throw Errors.notFound("Profile photo not found.");

  return new NextResponse(new Uint8Array(obj.buffer), {
    status: 200,
    headers: {
      "Content-Type": obj.contentType,
      "Content-Length": String(obj.buffer.length),
      // Private + short: the URL is the key, which changes on every upload.
      "Cache-Control": "private, max-age=60",
    },
  });
});

export const DELETE = handler(async ({ req, user }) => {
  const previous = await db.user.findUnique({ where: { id: user.id }, select: { avatarUrl: true } });
  if (!previous?.avatarUrl) return ok({ avatarUrl: null });
  await db.user.update({ where: { id: user.id }, data: { avatarUrl: null } });
  await storage.remove(previous.avatarUrl);
  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "PROFILE_PHOTO_CHANGED",
    resourceType: "User",
    resourceId: user.id,
    metadata: { scope: "self", removed: true },
    ip: clientIp(req),
  });
  return ok({ avatarUrl: null });
});
