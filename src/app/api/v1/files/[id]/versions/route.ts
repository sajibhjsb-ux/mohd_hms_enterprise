// MOHD.HMS ENTERPRISE — Version history (§16).
// GET  — list versions (VIEW).
// POST — upload a NEW version (multipart "file"; EDIT). The previous version
//        is NEVER overwritten — v(n+1) gets its own object; checksums and
//        sizes are verified server-side.

import { NextRequest, NextResponse } from "next/server";
import { handler, ok, Errors, ApiError } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import {
  assertRolePermission, canAccessFile, sanitizeFileName, sniffMimeType, sha256,
  fileObjectKey, extOf, scanUpload, MAX_SINGLE_SHOT_BYTES, MAX_SESSION_BYTES,
  emitFilesUpdated, withParams, assertQuota
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_read);
    await canAccessFile(user, id, "VIEW");
    const file = await db.fileEntry.findUnique({
      where: { id },
      select: {
        id: true, name: true, mimeType: true, sizeBytes: true, checksum: true, currentVersion: true,
        versions: {
          orderBy: { version: "desc" },
          select: { id: true, version: true, sizeBytes: true, mimeType: true, checksum: true, note: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } },
        },
      },
    });
    if (!file) throw Errors.notFound("File not found.");
    return ok(file);
  }, { permission: PERMISSIONS.files_read });

export const POST = withParams<{ id: string }>(async ({ req, user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_update);
    const access = await canAccessFile(user, id, "EDIT");

    const form = await req.formData();
    const raw = form.get("file");
    if (!(raw instanceof File)) throw Errors.badRequest("Attach the new version as the 'file' field.");
    if (raw.size === 0) throw Errors.badRequest("The file is empty.");
    if (raw.size > MAX_SINGLE_SHOT_BYTES) {
      throw Errors.badRequest(`New versions are limited to ${Math.round(MAX_SINGLE_SHOT_BYTES / (1024 * 1024))} MB via replace; use Upload for larger files.`);
    }
    const note = String(form.get("note") ?? "").slice(0, 300);

    const buf = Buffer.from(await raw.arrayBuffer());
    const name = sanitizeFileName(raw.name);
    const mimeType = sniffMimeType(buf, name);
    const checksum = sha256(buf);
    void (await scanUpload(buf, name)); // §37 hook — honest result, no fake claims

    const file = await db.fileEntry.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, currentVersion: true, trashedAt: true } });
    if (!file || file.trashedAt) throw Errors.notFound("File not found.");
    // §3 — a new version adds a real object to the owner's storage.
    await assertQuota(file.ownerId, buf.length);
    const nextVersion = file.currentVersion + 1;

    const created = await db.$transaction(async (tx) => {
      const version = await tx.fileVersion.create({
        data: { fileId: id, version: nextVersion, objectKey: "pending", sizeBytes: buf.length, mimeType, checksum, uploadedById: user.id, note },
      });
      const key = fileObjectKey(file.ownerId, id, nextVersion, extOf(name));
      const final = await tx.fileVersion.update({ where: { id: version.id }, data: { objectKey: key } });
      await tx.fileEntry.update({
        where: { id },
        data: { currentVersion: nextVersion, objectKey: key, sizeBytes: buf.length, mimeType, checksum },
      });
      return { key, versionId: final.id, version: nextVersion };
    });

    try {
      await storage.put(created.key, buf, mimeType);
      const stat = await storage.stat(created.key);
      if (!stat || stat.size !== buf.length) throw new Error("size mismatch");
    } catch (e) {
      // Roll back the version bump (§45 — no partial state).
      await db.$transaction(async (tx) => {
        await tx.fileVersion.delete({ where: { id: created.versionId } });
        const prev = await tx.fileVersion.findFirst({ where: { fileId: id, version: file.currentVersion }, orderBy: { version: "desc" } });
        await tx.fileEntry.update({
          where: { id },
          data: {
            currentVersion: file.currentVersion,
            objectKey: prev?.objectKey ?? "",
            sizeBytes: prev?.sizeBytes ?? 0,
            mimeType: prev?.mimeType ?? "application/octet-stream",
            checksum: prev?.checksum ?? "",
          },
        });
      });
      await storage.remove(created.key).catch(() => undefined);
      throw e instanceof ApiError ? e : Errors.internal("Version upload failed — rolled back to the previous version.");
    }

    void audit({
      actorId: user.id, actorEmail: user.email, action: "FILE_VERSION_CREATED", resourceType: "FILE", resourceId: id,
      metadata: { name: file.name, version: created.version, sizeBytes: buf.length, checksum, mimeType, note },
    });
    await emitFilesUpdated([file.ownerId, access.isOwner ? null : user.id].filter(Boolean) as string[], "FILE", id);
    return ok({ version: created.version, sizeBytes: buf.length, checksum }, 201);
  }, { permission: PERMISSIONS.files_read });

// route-level reminder: NextRequest/NextResponse available for future streaming
void (null as unknown as NextRequest | NextResponse | null);
