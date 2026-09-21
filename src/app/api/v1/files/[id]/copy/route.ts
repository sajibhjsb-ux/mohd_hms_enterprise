// MOHD.HMS ENTERPRISE — Copy a file (§6/§45).
// POST /api/v1/files/{id}/copy { folderId? } — reads the current version from
// MinIO, writes a NEW object under the copy's own key, verifies it, then
// creates the metadata in one transaction (no shared objects, no partial state).

import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import {
  assertRolePermission, canAccessFile, folderChain, fileObjectKey, extOf,
  assertQuota, emitFilesUpdated, withParams
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };
const copySchema = z.object({ folderId: z.string().max(64).nullable().optional() });

export const POST = withParams<{ id: string }>(async ({ req, user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_create);
    const body = await parseBody(req, copySchema).catch(() => ({ folderId: null }));
    const access = await canAccessFile(user, id, "DOWNLOAD"); // copying = reading the bytes
    void access;

    const file = await db.fileEntry.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, folderId: true, mimeType: true, sizeBytes: true, checksum: true, objectKey: true, trashedAt: true } });
    if (!file || file.trashedAt) throw Errors.notFound("File not found.");

    const targetFolderId = body.folderId !== undefined ? body.folderId : file.folderId;
    if (targetFolderId) {
      const chain = await folderChain(targetFolderId, user.id);
      if (!chain.some((f) => f.id === targetFolderId)) throw Errors.notFound("Destination folder not found.");
    }
    await assertQuota(user.id, file.sizeBytes);

    const obj = await storage.get(file.objectKey);
    if (!obj) throw Errors.notFound("File content is missing from storage.");

    const created = await db.$transaction(async (tx) => {
      const entry = await tx.fileEntry.create({
        data: { ownerId: user.id, name: `${file.name.replace(/(\.[^.]*)$/, "")} copy${file.name.match(/(\.[^.]*)$/)?.[1] ?? ""}`, mimeType: file.mimeType, sizeBytes: file.sizeBytes, checksum: file.checksum, objectKey: "pending", currentVersion: 1, folderId: targetFolderId },
      });
      const key = fileObjectKey(user.id, entry.id, 1, extOf(file.name));
      const version = await tx.fileVersion.create({
        data: { fileId: entry.id, version: 1, objectKey: key, sizeBytes: file.sizeBytes, mimeType: file.mimeType, checksum: file.checksum, uploadedById: user.id, note: `copied from ${file.name}` },
      });
      const final = await tx.fileEntry.update({ where: { id: entry.id }, data: { objectKey: key }, select: { id: true, name: true, sizeBytes: true, mimeType: true, folderId: true } });
      return { entry: final, key, versionId: version.id };
    });

    await storage.put(created.key, obj.buffer, file.mimeType);
    const stat = await storage.stat(created.key);
    if (!stat || stat.size !== file.sizeBytes) {
      await storage.remove(created.key).catch(() => undefined);
      await db.fileEntry.delete({ where: { id: created.entry.id } }).catch(() => undefined);
      throw Errors.internal("Copy verification failed — rolled back.");
    }

    void audit({
      actorId: user.id, actorEmail: user.email, action: "FILE_COPIED", resourceType: "FILE", resourceId: created.entry.id,
      metadata: { name: created.entry.name, sourceFileId: id, sourceName: file.name, folderId: targetFolderId },
    });
    await emitFilesUpdated([user.id], "FILE", created.entry.id);
    return ok({ file: created.entry }, 201);
  }, { permission: PERMISSIONS.files_read });
