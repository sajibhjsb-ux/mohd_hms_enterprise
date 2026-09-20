// MOHD.HMS ENTERPRISE — File detail operations (§6/§12/§17/§20).
// GET    — metadata (VIEW: owner or grant). IDOR-safe: foreign/unknown ids → 404.
// PATCH  — rename (EDIT) / move (owner; EDIT holders may not restructure).
// DELETE — trash (soft deletion §17, MANAGE = owner).

import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import {
  assertRolePermission, canAccessFile, sanitizeFileName, folderChain, emitFilesUpdated, withParams
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_read);
    const access = await canAccessFile(user, id, "VIEW");
    const file = await db.fileEntry.findUnique({
      where: { id },
      select: {
        id: true, name: true, mimeType: true, sizeBytes: true, checksum: true, objectKey: false,
        currentVersion: true, createdAt: true, updatedAt: true, folderId: true,
        ownerId: true, owner: { select: { id: true, name: true, email: true } },
        versions: { orderBy: { version: "desc" }, select: { id: true, version: true, sizeBytes: true, mimeType: true, checksum: true, createdAt: true, uploadedBy: { select: { id: true, name: true } }, note: true } },
        _count: { select: { versions: true } },
      },
    });
    if (!file) throw Errors.notFound("File not found.");

    const [breadcrumb, shareCount] = await Promise.all([
      file.folderId ? folderChain(file.folderId, file.ownerId) : Promise.resolve([]),
      db.fileShare.count({ where: { targetType: "FILE", targetId: id, revokedAt: null } }),
    ]);
    void audit({ actorId: user.id, actorEmail: user.email, action: "FILE_VIEWED", resourceType: "FILE", resourceId: id, metadata: { name: file.name } });
    return ok({
      file: { ...file, objectKey: undefined },
      breadcrumb,
      accessLevel: access.level,
      isOwner: access.isOwner,
      shareCount,
    });
  }, { permission: PERMISSIONS.files_read });

const patchSchema = z.object({
  name: z.string().max(512).optional(),
  folderId: z.string().max(64).nullable().optional(),
});

export const PATCH = withParams<{ id: string }>(async ({ req, user, params }) => {
    const { id } = params;
    const body = await parseBody(req, patchSchema);
    const access = await canAccessFile(user, id, "EDIT");
    if (!access.isOwner) assertRolePermission(user, PERMISSIONS.files_update);

    const current = await db.fileEntry.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, folderId: true, trashedAt: true } });
    if (!current || current.trashedAt) throw Errors.notFound("File not found.");

    const data: { name?: string; folderId?: string | null } = {};
    if (body.name !== undefined) {
      data.name = sanitizeFileName(body.name);
      if (data.name === current.name) data.name = current.name;
    }
    if (body.folderId !== undefined) {
      if (!access.isOwner) throw Errors.forbidden("Only the owner can move this file.");
      const newFolder = body.folderId;
      if (newFolder) {
        const chain = await folderChain(newFolder, current.ownerId);
        if (!chain.some((f) => f.id === newFolder)) throw Errors.notFound("Destination folder not found.");
      }
      data.folderId = newFolder;
    }
    if (Object.keys(data).length === 0) throw Errors.badRequest("Nothing to update.");

    const file = await db.$transaction(async (tx) =>
      tx.fileEntry.update({ where: { id }, data, select: { id: true, name: true, folderId: true, updatedAt: true } }),
    );
    if (data.name && data.name !== current.name) {
      void audit({ actorId: user.id, actorEmail: user.email, action: "FILE_RENAMED", resourceType: "FILE", resourceId: id, metadata: { name: data.name, previousName: current.name } });
    }
    if (body.folderId !== undefined && data.folderId !== current.folderId) {
      void audit({ actorId: user.id, actorEmail: user.email, action: "FILE_MOVED", resourceType: "FILE", resourceId: id, metadata: { name: file.name, fromFolderId: current.folderId, toFolderId: data.folderId ?? null } });
    }
    await emitFilesUpdated([current.ownerId], "FILE", id);
    return ok(file);
  }, { permission: PERMISSIONS.files_read });

export const DELETE = withParams<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_delete);
    const access = await canAccessFile(user, id, "MANAGE");
    if (!access.isOwner) throw Errors.forbidden("Only the owner can delete this file.");

    const file = await db.fileEntry.findUnique({ where: { id }, select: { id: true, name: true, trashedAt: true } });
    if (!file) throw Errors.notFound("File not found.");
    if (file.trashedAt) return ok({ trashed: true, alreadyTrashed: true });

    const now = new Date();
    await db.$transaction(async (tx) =>
      tx.fileEntry.update({
        where: { id },
        data: { trashedAt: now, trashedById: user.id, originalFolderId: (await tx.fileEntry.findUnique({ where: { id }, select: { folderId: true } }))?.folderId ?? null },
      }),
    );
    void audit({ actorId: user.id, actorEmail: user.email, action: "FILE_DELETED", resourceType: "FILE", resourceId: id, metadata: { name: file.name, trashedAt: now.toISOString() } });
    await emitFilesUpdated([user.id], "FILE", id);
    return ok({ trashed: true });
  }, { permission: PERMISSIONS.files_read });
