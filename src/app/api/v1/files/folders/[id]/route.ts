// MOHD.HMS ENTERPRISE — Folder detail operations (§7/§15/§17).
// GET    — browse the folder (breadcrumb + children). Owner OR folder grant (VIEW).
// PATCH  — rename/move. Owner OR folder grant (EDIT). Cycle guard (§7).
// DELETE — trash (soft deletion §17, batched timestamp for consistent restore).

import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import {
  assertRolePermission, canAccessFolder, sanitizeFolderName, assertNoFolderCycle,
  folderChain, descendantFolderIds, emitFilesUpdated, withParams,
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withParams<Ctx["params"] extends Promise<infer P> ? P : never>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_read);
    const access = await canAccessFolder(user, id, "VIEW");

    const folder = await db.fileFolder.findUnique({ where: { id }, select: { ownerId: true, parentId: true, name: true, createdAt: true, updatedAt: true } });
    if (!folder) throw Errors.notFound("Folder not found.");

    let chain: { id: string; name: string; parentId: string | null }[];
    if (access.isOwner) {
      chain = await folderChain(id, user.id);
    } else {
      // Grantee breadcrumb: shared root → … → folder (no owner's private names above it).
      chain = [];
      let cursor: string | null = id;
      let depth = 0;
      while (cursor && depth < 64) {
        const f = await db.fileFolder.findUnique({ where: { id: cursor }, select: { id: true, name: true, parentId: true } });
        if (!f) break;
        chain.push(f);
        cursor = f.parentId;
        depth += 1;
      }
      chain.reverse();
    }

    const [folders, files] = await Promise.all([
      db.fileFolder.findMany({
        where: { parentId: id, trashedAt: null },
        orderBy: { name: "asc" },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
      }),
      db.fileEntry.findMany({
        where: { folderId: id, trashedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, name: true, mimeType: true, sizeBytes: true, checksum: true, currentVersion: true,
          createdAt: true, updatedAt: true, ownerId: true, owner: { select: { id: true, name: true } },
        },
      }),
    ]);
    return ok({ view: "folder", folderId: id, accessLevel: access.level, isOwner: access.isOwner, breadcrumb: chain, folders, files });
  }, { permission: PERMISSIONS.files_read });

const patchSchema = z.object({
  name: z.string().max(120).optional(),
  parentId: z.string().max(64).nullable().optional(),
});

export const PATCH = withParams<{ id: string }>(async ({ req, user, params }) => {
    const { id } = params;
    const body = await parseBody(req, patchSchema);
    const access = await canAccessFolder(user, id, "EDIT");
    if (!access.isOwner) assertRolePermission(user, PERMISSIONS.files_update);

    const current = await db.fileFolder.findUnique({ where: { id }, select: { name: true, parentId: true, ownerId: true } });
    if (!current) throw Errors.notFound("Folder not found.");

    const data: { name?: string; parentId?: string | null } = {};
    if (body.name !== undefined) {
      data.name = sanitizeFolderName(body.name);
      const dup = await db.fileFolder.findFirst({
        where: { ownerId: current.ownerId, parentId: current.parentId ?? null, trashedAt: null, name: { equals: data.name }, id: { not: id } },
        select: { id: true },
      });
      if (dup) throw Errors.conflict(`A folder named “${data.name}” already exists here.`);
    }
    if (body.parentId !== undefined) {
      if (!access.isOwner) throw Errors.forbidden("Only the owner can move a shared folder.");
      const newParent = body.parentId;
      if (newParent) {
        const parent = await db.fileFolder.findFirst({ where: { id: newParent, ownerId: user.id, trashedAt: null }, select: { id: true } });
        if (!parent) throw Errors.notFound("Destination folder not found.");
      }
      await assertNoFolderCycle(id, newParent, user.id);
      data.parentId = newParent;
    }
    if (Object.keys(data).length === 0) throw Errors.badRequest("Nothing to update.");

    const folder = await db.$transaction(async (tx) =>
      tx.fileFolder.update({ where: { id }, data, select: { id: true, name: true, parentId: true, updatedAt: true } }),
    );
    void audit({
      actorId: user.id, actorEmail: user.email, action: "FOLDER_UPDATED", resourceType: "FILE_FOLDER", resourceId: id,
      metadata: { name: folder.name, previousName: current.name, moved: body.parentId !== undefined, newParentId: data.parentId ?? null },
    });
    await emitFilesUpdated([user.id], "FILE_FOLDER", id);
    return ok(folder);
  }, { permission: PERMISSIONS.files_read });

export const DELETE = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_delete);
    const access = await canAccessFolder(user, id, "MANAGE"); // trash needs MANAGE (owner)
    if (!access.isOwner) throw Errors.forbidden("Only the owner can delete this folder.");

    const now = new Date();
    const descendantIds = await descendantFolderIds(id, user.id);
    const allFolderIds = [id, ...descendantIds];
    // Files inside the subtree that are NOT already trashed join the same batch.
    const files = await db.fileEntry.findMany({
      where: { ownerId: user.id, folderId: { in: allFolderIds }, trashedAt: null },
      select: { id: true },
    });

    await db.$transaction(async (tx) => {
      await tx.fileFolder.update({ where: { id }, data: { trashedAt: now, trashedById: user.id } });
      await tx.fileFolder.updateMany({ where: { id: { in: descendantIds }, trashedAt: null }, data: { trashedAt: now, trashedById: user.id } });
      await tx.fileEntry.updateMany({ where: { id: { in: files.map((f) => f.id) }, trashedAt: null }, data: { trashedAt: now, trashedById: user.id } });
    });

    void audit({
      actorId: user.id, actorEmail: user.email, action: "FOLDER_DELETED", resourceType: "FILE_FOLDER", resourceId: id,
      metadata: { name: (await db.fileFolder.findUnique({ where: { id }, select: { name: true } }))?.name ?? "", filesAffected: files.length, subfolders: descendantIds.length },
    });
    await emitFilesUpdated([user.id], "FILE_FOLDER", id);
    return ok({ trashed: true, folderId: id, filesAffected: files.length });
  }, { permission: PERMISSIONS.files_read });
