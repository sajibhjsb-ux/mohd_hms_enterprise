// MOHD.HMS ENTERPRISE — Restore from trash (§17).
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { assertRolePermission, emitFilesUpdated, withParams
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_delete);
    const file = await db.fileEntry.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, trashedAt: true } });
    // Only the OWNER can restore (trash is owner-space; MANAGE sharers lose
    // access the moment the file is trashed anyway).
    if (!file || file.ownerId !== user.id) throw Errors.notFound("File not found.");
    if (!file.trashedAt) return ok({ restored: true, alreadyRestored: true });

    await db.fileEntry.update({
      where: { id },
      data: {
        trashedAt: null, trashedById: null,
        // Return to the original folder when it still exists and is not itself
        // trashed; otherwise back to the root.
        folderId: file.originalFolderId,
        originalFolderId: null,
      },
    });
    void audit({ actorId: user.id, actorEmail: user.email, action: "FILE_RESTORED", resourceType: "FILE", resourceId: id, metadata: { name: file.name } });
    await emitFilesUpdated([user.id], "FILE", id);
    return ok({ restored: true });
  }, { permission: PERMISSIONS.files_read });
