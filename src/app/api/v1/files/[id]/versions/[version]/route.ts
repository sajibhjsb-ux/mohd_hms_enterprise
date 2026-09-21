// MOHD.HMS ENTERPRISE — Single version download / restore (§16/§54).
// GET  /…/versions/{version}?as=inline|attachment — download a specific version.
// POST /…/versions/{version} — restore: the CURRENT version object is NOT
//      overwritten; the restored version becomes a NEW version (v(n+1)) whose
//      object is a fresh copy — full history is preserved (§54).

import { NextResponse } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import {
  assertRolePermission, canAccessFile, dispositionFor, fileObjectKey, extOf, emitFilesUpdated, withParams
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string; version: string }> };

export const GET = withParams<{ id: string; version: string }>(async ({ req, user, params }) => {
    const { id, version: rawVersion } = params;
    assertRolePermission(user, PERMISSIONS.files_read);
    const version = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(version) || version < 1) throw Errors.badRequest("Invalid version.");
    await canAccessFile(user, id, "VIEW");

    const v = await db.fileVersion.findUnique({ where: { fileId_version: { fileId: id, version } }, select: { id: true, objectKey: true, sizeBytes: true, mimeType: true, checksum: true } });
    if (!v) throw Errors.notFound("Version not found.");

    const as = new URL(req.url).searchParams.get("as") === "inline" ? "inline" : "attachment";
    if (as === "attachment") await canAccessFile(user, id, "DOWNLOAD");
    if (as === "inline" && dispositionFor(v.mimeType) !== "inline") await canAccessFile(user, id, "DOWNLOAD");

    const obj = await storage.get(v.objectKey);
    if (!obj) throw Errors.notFound("Version content is missing from storage.");

    const file = await db.fileEntry.findUnique({ where: { id }, select: { name: true } });
    void audit({
      actorId: user.id, actorEmail: user.email, action: "FILE_VIEWED", resourceType: "FILE", resourceId: id,
      metadata: { name: file?.name ?? "", version, as, checksum: v.checksum },
    });
    const safeName = (file?.name ?? "file").replace(/["\\\r\n]/g, "_");
    return new NextResponse(new Uint8Array(obj.buffer), {
      status: 200,
      headers: {
        "Content-Type": v.mimeType || "application/octet-stream",
        "Content-Length": String(obj.buffer.length),
        "Content-Disposition": `${as === "inline" && dispositionFor(v.mimeType) === "inline" ? "inline" : "attachment"}; filename="${safeName}"`,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }, { permission: PERMISSIONS.files_read });

export const POST = withParams<{ id: string; version: string }>(async ({ user, params }) => {
    const { id, version: rawVersion } = params;
    assertRolePermission(user, PERMISSIONS.files_update);
    const access = await canAccessFile(user, id, "EDIT");
    const version = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(version) || version < 1) throw Errors.badRequest("Invalid version.");

    const file = await db.fileEntry.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, currentVersion: true, trashedAt: true } });
    if (!file || file.trashedAt) throw Errors.notFound("File not found.");
    if (version === file.currentVersion) return ok({ restored: true, currentVersion: version, alreadyCurrent: true });

    const v = await db.fileVersion.findUnique({ where: { fileId_version: { fileId: id, version } }, select: { id: true, objectKey: true, sizeBytes: true, mimeType: true, checksum: true } });
    if (!v) throw Errors.notFound("Version not found.");

    // Read the historical object, write it as a NEW version object (history intact).
    const obj = await storage.get(v.objectKey);
    if (!obj) throw Errors.notFound("Version content is missing from storage.");
    const nextVersion = file.currentVersion + 1;
    const key = fileObjectKey(file.ownerId, id, nextVersion, extOf(file.name));
    await storage.put(key, obj.buffer, v.mimeType);
    const stat = await storage.stat(key);
    if (!stat || stat.size !== v.sizeBytes) {
      await storage.remove(key).catch(() => undefined);
      throw Errors.internal("Restore verification failed — nothing changed.");
    }

    await db.$transaction(async (tx) => {
      await tx.fileVersion.create({
        data: { fileId: id, version: nextVersion, objectKey: key, sizeBytes: v.sizeBytes, mimeType: v.mimeType, checksum: v.checksum, uploadedById: user.id, note: `restored from version ${version}` },
      });
      await tx.fileEntry.update({
        where: { id },
        data: { currentVersion: nextVersion, objectKey: key, sizeBytes: v.sizeBytes, mimeType: v.mimeType, checksum: v.checksum },
      });
    });

    void audit({
      actorId: user.id, actorEmail: user.email, action: "FILE_VERSION_RESTORED", resourceType: "FILE", resourceId: id,
      metadata: { name: file.name, restoredFrom: version, newCurrentVersion: nextVersion, checksum: v.checksum },
    });
    await emitFilesUpdated([file.ownerId, access.isOwner ? null : user.id].filter(Boolean) as string[], "FILE", id);
    return ok({ restored: true, newCurrentVersion: nextVersion, fromVersion: version });
  }, { permission: PERMISSIONS.files_read });
