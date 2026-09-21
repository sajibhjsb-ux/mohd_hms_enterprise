// MOHD.HMS ENTERPRISE — Permanently delete a folder + everything inside (§17).
// Owner only. Removes every file version object in the subtree from MinIO,
// then the metadata rows; the audit trail always remains (§55).
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit, notify } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import { assertRolePermission, descendantFolderIds, emitFilesUpdated, withParams
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_delete);
    const folder = await db.fileFolder.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true } });
    if (!folder || folder.ownerId !== user.id) throw Errors.notFound("Folder not found.");

    const folderIds = [id, ...(await descendantFolderIds(id, user.id))];
    const files = await db.fileEntry.findMany({
      where: { ownerId: user.id, folderId: { in: folderIds } },
      select: { id: true, name: true, objectKey: true, versions: { select: { objectKey: true } } },
    });

    const keys = [...new Set(files.flatMap((f) => [f.objectKey, ...f.versions.map((v) => v.objectKey)]))].filter(Boolean);
    for (const key of keys) await storage.remove(key).catch(() => undefined);

    await db.$transaction(async (tx) => {
      await tx.fileShare.deleteMany({ where: { targetType: "FOLDER", targetId: { in: folderIds } } });
      await tx.fileStar.deleteMany({ where: { targetType: "FOLDER", targetId: { in: folderIds } } });
      await tx.fileFolder.deleteMany({ where: { id: { in: folderIds } } });
      for (const f of files) {
        await tx.fileShare.deleteMany({ where: { targetType: "FILE", targetId: f.id } });
        await tx.fileStar.deleteMany({ where: { targetType: "FILE", targetId: f.id } });
        await tx.fileVersion.deleteMany({ where: { fileId: f.id } });
        await tx.fileEntry.delete({ where: { id: f.id } });
      }
    });

    void audit({
      actorId: user.id, actorEmail: user.email, action: "FOLDER_PERMANENTLY_DELETED", resourceType: "FILE_FOLDER", resourceId: id,
      metadata: { name: folder.name, filesRemoved: files.length, foldersRemoved: folderIds.length, objectsRemoved: keys.length },
    });
    void notify({
      userId: user.id, title: "Folder permanently deleted",
      message: `“${folder.name}” and ${files.length} file(s) inside it were permanently deleted. This cannot be undone.`,
      type: "WARNING", channels: ["IN_APP"],
    });
    await emitFilesUpdated([user.id], "FILE_FOLDER", id);
    return ok({ purged: true, foldersRemoved: folderIds.length, filesRemoved: files.length, objectsRemoved: keys.length });
  }, { permission: PERMISSIONS.files_read });
