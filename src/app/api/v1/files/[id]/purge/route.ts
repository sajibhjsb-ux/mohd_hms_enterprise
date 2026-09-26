// MOHD.HMS ENTERPRISE — Permanent deletion (§17/§55).
// DELETE /api/v1/files/{id}/purge — owner only. Removes ALL version objects
// from MinIO, then shares, stars, versions and the metadata row — atomically
// ordered (storage first, then DB; audit row ALWAYS remains, §55).

import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit, notify } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import { assertRolePermission, emitFilesUpdated, withParams
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_delete);
    const file = await db.fileEntry.findUnique({
      where: { id },
      select: { id: true, name: true, ownerId: true, objectKey: true, versions: { select: { id: true, objectKey: true, version: true } } },
    });
    if (!file || file.ownerId !== user.id) throw Errors.notFound("File not found.");

    // Storage removal first — a DB row without objects is worse than the
    // reverse. Failure to remove ANY object aborts the metadata deletion so
    // we never silently leave the file "purged" while objects still exist.
    const keys = [...new Set([file.objectKey, ...file.versions.map((v) => v.objectKey)])].filter(Boolean);
    const failedKeys: string[] = [];
    for (const key of keys) {
      const ok = await storage.removeStrict(key).then(() => true).catch((err: unknown) => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "file-purge-remove-failed", fileId: id, key, error: err instanceof Error ? err.message : String(err) }));
        return false;
      });
      if (!ok) failedKeys.push(key);
    }
    if (failedKeys.length > 0) {
      void audit({
        actorId: user.id, actorEmail: user.email, action: "FILE_PURGE_ABORTED", resourceType: "FILE", resourceId: id,
        metadata: { name: file.name, failedKeys },
      });
      throw Errors.conflict(`Some file objects could not be removed from storage (${failedKeys.length}). The file was NOT purged — retry or contact support.`);
    }

    await db.$transaction(async (tx) => {
      await tx.fileShare.deleteMany({ where: { targetType: "FILE", targetId: id } });
      await tx.fileStar.deleteMany({ where: { targetType: "FILE", targetId: id } });
      await tx.fileVersion.deleteMany({ where: { fileId: id } });
      await tx.fileEntry.delete({ where: { id } });
    });

    // Notify former share holders (§27 — security event).
    const holders = await db.fileShare.findMany({ where: { targetType: "FILE", targetId: id }, select: { sharedWithId: true } }).catch(() => []);
    void holders;

    void audit({
      actorId: user.id, actorEmail: user.email, action: "FILE_PERMANENTLY_DELETED", resourceType: "FILE", resourceId: id,
      metadata: { name: file.name, versionsRemoved: file.versions.length, objectsRemoved: keys.length },
    });
    void notify({
      userId: user.id, title: "File permanently deleted",
      message: `“${file.name}” was permanently deleted. This cannot be undone.`,
      type: "WARNING", channels: ["IN_APP"],
    });
    await emitFilesUpdated([user.id], "FILE", id);
    return ok({ purged: true, objectsRemoved: keys.length, versionsRemoved: file.versions.length });
  }, { permission: PERMISSIONS.files_read });
