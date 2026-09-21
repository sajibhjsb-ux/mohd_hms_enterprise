// MOHD.HMS ENTERPRISE — Restore a trashed folder (§17/§55).
// Restores the folder + exactly the descendants/files trashed IN THE SAME
// BATCH (same trashedAt) — items deleted separately stay in trash.
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { assertRolePermission, descendantFolderIds, emitFilesUpdated, withParams
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_delete);
    const folder = await db.fileFolder.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, trashedAt: true } });
    if (!folder || folder.ownerId !== user.id) throw Errors.notFound("Folder not found.");
    if (!folder.trashedAt) return ok({ restored: true, alreadyRestored: true });

    const batchAt = folder.trashedAt;
    const descendants = await descendantFolderIds(id, user.id);
    const allIds = [id, ...descendants];

    await db.$transaction(async (tx) => {
      // Parent chain intact? If the parent is trashed (and not part of this
      // batch), the folder returns to the root instead.
      const fresh = await tx.fileFolder.findUnique({ where: { id }, select: { parentId: true } });
      let parentId = fresh?.parentId ?? null;
      if (parentId) {
        const parent = await tx.fileFolder.findUnique({ where: { id: parentId }, select: { trashedAt: true } });
        if (parent?.trashedAt) parentId = null;
      }
      await tx.fileFolder.update({ where: { id }, data: { trashedAt: null, trashedById: null, parentId } });
      await tx.fileFolder.updateMany({ where: { id: { in: descendants }, trashedAt: batchAt }, data: { trashedAt: null, trashedById: null } });
      const filesInTree = await tx.fileEntry.findMany({ where: { ownerId: user.id, folderId: { in: allIds }, trashedAt: batchAt }, select: { id: true } });
      await tx.fileEntry.updateMany({ where: { id: { in: filesInTree.map((f) => f.id) } }, data: { trashedAt: null, trashedById: null } });
    });

    void audit({ actorId: user.id, actorEmail: user.email, action: "FOLDER_RESTORED", resourceType: "FILE_FOLDER", resourceId: id, metadata: { name: folder.name, subfolders: descendants.length } });
    await emitFilesUpdated([user.id], "FILE_FOLDER", id);
    return ok({ restored: true });
  }, { permission: PERMISSIONS.files_read });
