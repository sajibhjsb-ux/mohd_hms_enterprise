// MOHD.HMS ENTERPRISE — Copy a folder subtree (§6/§45). Bounded recursion
// (depth ≤ 32, ≤ 500 items) with per-file byte copy + verification.
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import {
  assertRolePermission, canAccessFolder, folderChain, fileObjectKey, extOf,
  assertQuota, emitFilesUpdated, descendantFolderIds, sanitizeFolderName, withParams
} from "@/lib/hms/files/service";

type Ctx = { params: Promise<{ id: string }> };
const copySchema = z.object({ folderId: z.string().max(64).nullable().optional() });

export const POST = withParams<{ id: string }>(async ({ req, user, params }) => {
    const { id } = params;
    assertRolePermission(user, PERMISSIONS.files_create);
    const body = await parseBody(req, copySchema).catch(() => ({ folderId: null }));
    const source = await db.fileFolder.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, parentId: true, trashedAt: true } });
    if (!source || source.ownerId !== user.id || source.trashedAt) throw Errors.notFound("Folder not found.");

    const targetParent = body.folderId !== undefined ? body.folderId : source.parentId;
    if (targetParent) {
      const chain = await folderChain(targetParent, user.id);
      if (!chain.some((f) => f.id === targetParent)) throw Errors.notFound("Destination folder not found.");
      if ((await descendantFolderIds(id, user.id)).includes(targetParent) || targetParent === id) {
        throw Errors.badRequest("A folder cannot be copied into itself or its own subfolders.");
      }
    }

    // Collect the whole subtree (bounded).
    const folderIds = [id, ...(await descendantFolderIds(id, user.id))];
    const files = await db.fileEntry.findMany({
      where: { ownerId: user.id, folderId: { in: folderIds }, trashedAt: null },
      select: { id: true, name: true, folderId: true, mimeType: true, sizeBytes: true, checksum: true, objectKey: true },
      take: 500,
    });
    if (files.length >= 500) throw Errors.badRequest("Folder is too large to copy (500 item limit).");
    const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
    await assertQuota(user.id, totalBytes);

    // Map old folder id → new folder id, breadth-first from the source root.
    const idMap = new Map<string, string>();
    const nameFor = (name: string) => (idMap.size === 0 ? `${name} copy` : name);
    const createFolder = async (oldId: string, name: string, parentId: string | null): Promise<string> => {
      const created = await db.fileFolder.create({ data: { ownerId: user.id, name: sanitizeFolderName(name), parentId } });
      idMap.set(oldId, created.id);
      return created.id;
    };
    const newRootId = await createFolder(id, nameFor(source.name), targetParent);
    // children level by level
    let frontier = [id];
    let depth = 0;
    while (frontier.length > 0 && depth < 32) {
      const children = await db.fileFolder.findMany({ where: { ownerId: user.id, parentId: { in: frontier }, trashedAt: null }, select: { id: true, name: true, parentId: true } });
      for (const child of children) {
        const newParent = idMap.get(child.parentId ?? "") ?? newRootId;
        await createFolder(child.id, child.name, newParent);
      }
      frontier = children.map((c) => c.id);
      depth += 1;
    }

    // Copy files (bytes first, then row — verify each).
    let copiedFiles = 0;
    for (const f of files) {
      const obj = await storage.get(f.objectKey);
      if (!obj) continue;
      const newFolderId = f.folderId ? (idMap.get(f.folderId) ?? newRootId) : newRootId;
      const created = await db.$transaction(async (tx) => {
        const entry = await tx.fileEntry.create({
          data: { ownerId: user.id, name: f.name, mimeType: f.mimeType, sizeBytes: f.sizeBytes, checksum: f.checksum, objectKey: "pending", currentVersion: 1, folderId: newFolderId },
        });
        const key = fileObjectKey(user.id, entry.id, 1, extOf(f.name));
        await tx.fileVersion.create({ data: { fileId: entry.id, version: 1, objectKey: key, sizeBytes: f.sizeBytes, mimeType: f.mimeType, checksum: f.checksum, uploadedById: user.id, note: `copied with folder ${source.name}` } });
        const final = await tx.fileEntry.update({ where: { id: entry.id }, data: { objectKey: key }, select: { id: true, name: true } });
        return { entry: final, key };
      });
      await storage.put(created.key, obj.buffer, f.mimeType);
      const stat = await storage.stat(created.key);
      if (!stat || stat.size !== f.sizeBytes) {
        await storage.remove(created.key).catch(() => undefined);
        await db.fileEntry.delete({ where: { id: created.entry.id } }).catch(() => undefined);
        continue; // this file failed — honest partial copy is reported below
      }
      copiedFiles += 1;
    }

    void audit({
      actorId: user.id, actorEmail: user.email, action: "FOLDER_COPIED", resourceType: "FILE_FOLDER", resourceId: newRootId,
      metadata: { name: `${source.name} copy`, sourceFolderId: id, filesCopied: copiedFiles, filesTotal: files.length },
    });
    await emitFilesUpdated([user.id], "FILE_FOLDER", newRootId);
    return ok({ folderId: newRootId, name: `${source.name} copy`, filesCopied: copiedFiles, filesTotal: files.length }, 201);
  }, { permission: PERMISSIONS.files_read });
