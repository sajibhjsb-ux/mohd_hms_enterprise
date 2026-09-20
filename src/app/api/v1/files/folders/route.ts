// MOHD.HMS ENTERPRISE — Create folder (§7). Owner = current user (server-derived).
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { assertRolePermission, sanitizeFolderName, folderChain, emitFilesUpdated } from "@/lib/hms/files/service";

const createSchema = z.object({
  name: z.string().max(120),
  parentId: z.string().max(64).nullable().optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    assertRolePermission(user, PERMISSIONS.files_create);
    const body = await parseBody(req, createSchema);
    const name = sanitizeFolderName(body.name);
    const parentId = body.parentId ?? null;

    if (parentId) {
      // Parent must exist and belong to the caller (IDOR §12).
      const chain = await folderChain(parentId, user.id);
      if (!chain.some((f) => f.id === parentId)) throw Errors.notFound("Destination folder not found.");
    }
    // Duplicate folder names within the same parent are rejected (predictable trees).
    const dup = await db.fileFolder.findFirst({
      where: { ownerId: user.id, parentId, trashedAt: null, name: { equals: name } },
      select: { id: true },
    });
    if (dup) throw Errors.conflict(`A folder named “${name}” already exists here.`);

    const folder = await db.fileFolder.create({
      data: { ownerId: user.id, parentId, name },
      select: { id: true, name: true, parentId: true, createdAt: true, updatedAt: true },
    });
    void audit({ actorId: user.id, actorEmail: user.email, action: "FOLDER_CREATED", resourceType: "FILE_FOLDER", resourceId: folder.id, metadata: { name, parentId } });
    await emitFilesUpdated([user.id], "FILE_FOLDER", folder.id);
    return ok(folder, 201);
  },
  { permission: PERMISSIONS.files_create },
);
