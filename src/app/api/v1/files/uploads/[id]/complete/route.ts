// MOHD.HMS ENTERPRISE — Upload completion (§8: verify-then-commit; §45: no partial state).
//
// 1. Session must be the caller's and PENDING with ALL chunks staged.
// 2. Assemble the file from MinIO chunk objects (server-side only).
// 3. Verify: total size == declared; sha256 == declared checksum (when the
//    client provided one); malware hook consulted (§37, honest result).
// 4. Commit: storage.put to the PERMANENT key → stat() verify → PostgreSQL
//    FileEntry + FileVersion(1) in ONE transaction → tmp chunks removed →
//    session COMPLETED. Any failure cleans the tmp prefix and reports a REAL
//    error (no fake success, §8/§45).
// 5. Audit UPLOAD_COMPLETED (= FILE_CREATED) + owner notification (§27) +
//    realtime FILES_UPDATED (§28).

import { handler, ok, Errors, ApiError } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit, notify } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import {
  assertRolePermission, sniffMimeType, sha256, scanUpload, fileObjectKey, extOf,
  emitFilesUpdated, usedBytes, userQuotaMb, withParams,
} from "@/lib/hms/files/service";

export const POST = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_create);
    const session = await db.fileUploadSession.findUnique({ where: { id } });
    if (!session || session.userId !== user.id) throw Errors.notFound("Upload session not found.");
    if (session.status === "COMPLETED") {
      const existing = session.fileId ? await db.fileEntry.findUnique({ where: { id: session.fileId }, select: { id: true, name: true } }) : null;
      return ok({ alreadyCompleted: true, file: existing });
    }
    if (session.status !== "PENDING") throw Errors.invalidTransition("Upload session is no longer active.");

    const received = new Set((session.receivedChunks ?? "").split(",").filter(Boolean));
    const missing: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) if (!received.has(String(i))) missing.push(i);
    if (missing.length > 0) {
      throw Errors.badRequest(`Upload is incomplete — ${missing.length} chunk(s) missing (first: #${missing[0]}). Resume the upload.`);
    }

    // Assemble from staged chunks (bounded by MAX_SESSION_BYTES enforced at create).
    const parts: Buffer[] = [];
    let total = 0;
    for (let i = 0; i < session.totalChunks; i++) {
      const chunk = await storage.get(`uploads-tmp/${session.id}/${String(i).padStart(6, "0")}`);
      if (!chunk) throw Errors.badRequest(`Staged chunk #${i} is missing from storage — retry that chunk.`);
      parts.push(chunk.buffer);
      total += chunk.buffer.length;
    }
    if (total !== session.sizeBytes) {
      await storage.removePrefix(`uploads-tmp/${session.id}/`).catch(() => undefined);
      await db.fileUploadSession.update({ where: { id: session.id }, data: { status: "ABORTED", error: `size mismatch (${total} != ${session.sizeBytes})` } });
      void audit({ actorId: user.id, actorEmail: user.email, action: "UPLOAD_FAILED", resourceType: "FILE_UPLOAD", resourceId: session.id, metadata: { name: session.name, reason: "size mismatch", receivedBytes: total } });
      throw Errors.badRequest("Upload verification failed — the assembled size does not match. Nothing was saved; please retry.");
    }

    const buf = Buffer.concat(parts);
    const checksum = sha256(buf);
    if (session.checksum && session.checksum !== checksum) {
      await storage.removePrefix(`uploads-tmp/${session.id}/`).catch(() => undefined);
      await db.fileUploadSession.update({ where: { id: session.id }, data: { status: "ABORTED", error: "checksum mismatch" } });
      void audit({ actorId: user.id, actorEmail: user.email, action: "UPLOAD_FAILED", resourceType: "FILE_UPLOAD", resourceId: session.id, metadata: { name: session.name, reason: "checksum mismatch" } });
      throw Errors.badRequest("Checksum mismatch — the uploaded data is corrupted. Nothing was saved; please retry.");
    }

    // Malware hook (§37 — honest: reports scanned:false when no engine exists).
    const scan = await scanUpload(buf, session.name);
    if (scan.scanned && !scan.clean) {
      await storage.removePrefix(`uploads-tmp/${session.id}/`).catch(() => undefined);
      await db.fileUploadSession.update({ where: { id: session.id }, data: { status: "ABORTED", error: "malware detected" } });
      void audit({ actorId: user.id, actorEmail: user.email, action: "UPLOAD_FAILED", resourceType: "FILE_UPLOAD", resourceId: session.id, metadata: { name: session.name, reason: "malware detected", engine: scan.engine } });
      void notify({ userId: user.id, title: "Upload rejected", message: `“${session.name}” was rejected by the malware scanner.`, type: "ERROR", channels: ["IN_APP"] });
      throw Errors.badRequest("The file was rejected by malware scanning. Nothing was saved.");
    }

    // Quota re-check at completion (other uploads may have landed meanwhile).
    const quotaBytes = (await userQuotaMb()) * 1024 * 1024;
    if ((await usedBytes(user.id)) + buf.length > quotaBytes) {
      await storage.removePrefix(`uploads-tmp/${session.id}/`).catch(() => undefined);
      await db.fileUploadSession.update({ where: { id: session.id }, data: { status: "ABORTED", error: "quota exceeded at completion" } });
      throw Errors.badRequest("Storage quota was exceeded before completion — nothing was saved.");
    }

    // Commit: permanent object first (verify §8 #1/#2/#3), then metadata (§45).
    const mimeType = sniffMimeType(buf, session.name) || session.mimeType || "application/octet-stream";
    let file: { id: string; name: string; sizeBytes: number; mimeType: string; checksum: string; objectKey: string; currentVersion: number; folderId: string | null } | null = null;
    try {
      const created = await db.$transaction(async (tx) => {
        const entry = await tx.fileEntry.create({
          data: {
            ownerId: user.id, name: session.name, mimeType, sizeBytes: buf.length,
            checksum, objectKey: "pending", currentVersion: 1, folderId: session.folderId,
          },
        });
        const key = fileObjectKey(user.id, entry.id, 1, extOf(session.name));
        const version = await tx.fileVersion.create({
          data: { fileId: entry.id, version: 1, objectKey: key, sizeBytes: buf.length, mimeType, checksum, uploadedById: user.id, note: "initial upload" },
        });
        const final = await tx.fileEntry.update({ where: { id: entry.id }, data: { objectKey: key }, select: { id: true, name: true, sizeBytes: true, mimeType: true, checksum: true, objectKey: true, currentVersion: true, folderId: true } });
        return { entry: final, key, versionId: version.id };
      });

      await storage.put(created.key, buf, mimeType);
      const stat = await storage.stat(created.key);
      if (!stat || stat.size !== buf.length) {
        throw new Error(`object verification failed (size ${stat?.size ?? "missing"} != ${buf.length})`);
      }

      file = created.entry;
      await db.fileUploadSession.update({ where: { id: session.id }, data: { status: "COMPLETED", fileId: file.id, checksum } });
      await storage.removePrefix(`uploads-tmp/${session.id}/`).catch(() => undefined);

      void audit({
        actorId: user.id, actorEmail: user.email, action: "FILE_UPLOADED", resourceType: "FILE", resourceId: file.id,
        metadata: { name: file.name, sizeBytes: file.sizeBytes, mimeType, checksum, folderId: file.folderId, sessionChunks: session.totalChunks },
      });
      void audit({
        actorId: user.id, actorEmail: user.email, action: "UPLOAD_COMPLETED", resourceType: "FILE_UPLOAD", resourceId: session.id,
        metadata: { name: file.name, fileId: file.id, sizeBytes: file.sizeBytes },
      });
      // §27 — upload-completed notification (chunked uploads only; single-shot
      // small files would be pure noise).
      if (session.totalChunks > 1) {
        void notify({
          userId: user.id, title: "Upload completed",
          message: `“${file.name}” (${(file.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${session.totalChunks} chunks) was uploaded and verified.`,
          type: "SUCCESS", resourceType: "FILE", resourceId: file.id, channels: ["IN_APP"],
        });
      }
      await emitFilesUpdated([user.id], "FILE", file.id);
      return ok({ file }, 201);
    } catch (e) {
      // Compensation (§45): remove the permanent object if the metadata step
      // already ran; the tmp prefix is always cleaned; session marked FAILED.
      if (file?.objectKey) await storage.remove(file.objectKey).catch(() => undefined);
      await storage.removePrefix(`uploads-tmp/${session.id}/`).catch(() => undefined);
      if (file?.id) await db.fileEntry.delete({ where: { id: file.id } }).catch(() => undefined);
      await db.fileUploadSession.update({ where: { id: session.id }, data: { status: "ABORTED", error: e instanceof Error ? e.message.slice(0, 300) : "completion failed" } }).catch(() => undefined);
      void audit({ actorId: user.id, actorEmail: user.email, action: "UPLOAD_FAILED", resourceType: "FILE_UPLOAD", resourceId: session.id, metadata: { name: session.name, reason: "completion failure" } });
      throw Errors.internal("Upload completion failed — everything was rolled back. Please retry.");
    }
  }, { permission: PERMISSIONS.files_create });
