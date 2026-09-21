// MOHD.HMS ENTERPRISE — Files list/search API (§6/§14/§15/§22/§23/§24/§17/§56).
// GET /api/v1/files — ONE authorized listing endpoint:
//   view=mine          → private browser (folders + files at folderId, breadcrumb)
//   view=shared        → files explicitly shared with me (§14)
//   view=shared-folders→ folders shared with me (§15)
//   view=starred       → my favorites (§23, authorization re-checked per item)
//   view=trash         → my soft-deleted items (§17)
//   view=recent        → my real activity feed (§24 — no fake timestamps)
//   view=search        → server-side scoped search (§22/§56 — NEVER leaks)
//
// Search scope is computed IN THE QUERY: my own files + files granted directly
// + files inside folders granted to me (inheritance expanded server-side).
// There is no unrestricted query that the browser filters afterwards.

import { NextRequest } from "next/server";
import { handler, ok, listQuery } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { canAccessFolder, canAccessFile, folderChain, descendantFolderIds } from "@/lib/hms/files/service";

export const GET = handler(
  async ({ req, user }) => {
    const url = new URL(req.url as string);
    const view = url.searchParams.get("view") ?? "mine";

    if (view === "mine") return listMine(url, user.id);
    if (view === "shared") return listSharedFiles(user.id);
    if (view === "shared-folders") return listSharedFolders(user.id);
    if (view === "starred") return listStarred(user.id);
    if (view === "trash") return listTrash(user.id);
    if (view === "recent") return listRecent(req, user.id);
    if (view === "search") return search(url, user.id);
    return ok({ folders: [], files: [], breadcrumb: [] });
  },
  { permission: PERMISSIONS.files_read },
);

type FileRow = Awaited<ReturnType<typeof fileRows>>[number];

async function fileRows(where: { folderId: string | null; ownerId: string }) {
  return db.fileEntry.findMany({
    where: { ...where, trashedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, mimeType: true, sizeBytes: true, checksum: true,
      currentVersion: true, createdAt: true, updatedAt: true, ownerId: true,
    },
  });
}

async function listMine(url: URL, userId: string) {
  const folderId = url.searchParams.get("folderId") || null;
  // Folder id must belong to the caller (IDOR §12) — throws 404 otherwise.
  if (folderId) await canAccessFolder({ id: userId }, folderId, "VIEW");
  const [breadcrumb, folders, files] = await Promise.all([
    folderId ? folderChain(folderId, userId) : Promise.resolve([]),
    db.fileFolder.findMany({
      where: { ownerId: userId, parentId: folderId, trashedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, createdAt: true, updatedAt: true, parentId: true },
    }),
    fileRows({ folderId, ownerId: userId }),
  ]);
  return ok({ view: "mine", folderId, breadcrumb, folders, files });
}

/** My active FILE grants → the granted files (§14). Trashed/purged targets vanish. */
async function listSharedFiles(userId: string) {
  const grants = await db.fileShare.findMany({
    where: {
      targetType: "FILE", sharedWithId: userId, revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
    select: { targetId: true, permission: true, expiresAt: true, createdAt: true, sharedById: true },
  });
  const ids = grants.map((g) => g.targetId);
  const files = await db.fileEntry.findMany({
    where: { id: { in: ids }, trashedAt: null },
    select: {
      id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true, updatedAt: true,
      ownerId: true, owner: { select: { id: true, name: true, email: true } },
    },
  });
  const byId = new Map(files.map((f) => [f.id, f]));
  const sharedByIds = await userNameMap(grants.map((g) => g.sharedById));
  const rows = grants
    .filter((g) => byId.has(g.targetId))
    .map((g) => ({ ...byId.get(g.targetId)!, permission: g.permission, expiresAt: g.expiresAt, sharedBy: sharedByIds.get(g.sharedById) ?? null, sharedAt: g.createdAt }));
  return ok({ view: "shared", files: rows });
}

/** My active FOLDER grants → granted folders (§15). */
async function listSharedFolders(userId: string) {
  const grants = await db.fileShare.findMany({
    where: {
      targetType: "FOLDER", sharedWithId: userId, revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
    select: { targetId: true, permission: true, expiresAt: true, createdAt: true, sharedById: true },
  });
  const ids = grants.map((g) => g.targetId);
  const folders = await db.fileFolder.findMany({
    where: { id: { in: ids }, trashedAt: null },
    select: { id: true, name: true, createdAt: true, updatedAt: true, ownerId: true, owner: { select: { id: true, name: true, email: true } } },
  });
  const byId = new Map(folders.map((f) => [f.id, f]));
  const sharedByIds = await userNameMap(grants.map((g) => g.sharedById));
  const rows = grants
    .filter((g) => byId.has(g.targetId))
    .map((g) => ({ ...byId.get(g.targetId)!, permission: g.permission, expiresAt: g.expiresAt, sharedBy: sharedByIds.get(g.sharedById) ?? null, sharedAt: g.createdAt }));
  return ok({ view: "shared-folders", folders: rows });
}

async function listStarred(userId: string) {
  const stars = await db.fileStar.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { targetType: true, targetId: true, createdAt: true },
  });

  const fileIds = stars.filter((s) => s.targetType === "FILE").map((s) => s.targetId);
  const folderIds = stars.filter((s) => s.targetType === "FOLDER").map((s) => s.targetId);
  const [files, folders] = await Promise.all([
    db.fileEntry.findMany({
      where: { id: { in: fileIds }, trashedAt: null },
      select: { id: true, name: true, mimeType: true, sizeBytes: true, updatedAt: true, ownerId: true },
    }),
    db.fileFolder.findMany({
      where: { id: { in: folderIds }, trashedAt: null },
      select: { id: true, name: true, updatedAt: true, ownerId: true },
    }),
  ]);
  // Authorization re-check per item (§23 — "show only items the current user
  // has permission to access"): stars on revoked/lost items disappear.
  const fileRowsOut = [];
  for (const f of files) {
    try { await canAccessFile({ id: userId }, f.id, "VIEW"); fileRowsOut.push(f); } catch { /* lost access (§23) */ }
  }
  const folderRowsOut = [];
  for (const f of folders) {
    try { await canAccessFolder({ id: userId }, f.id, "VIEW"); folderRowsOut.push(f); } catch { /* lost access */ }
  }
  return ok({ view: "starred", files: fileRowsOut, folders: folderRowsOut });
}

async function listTrash(userId: string) {
  const [files, folders] = await Promise.all([
    db.fileEntry.findMany({
      where: { ownerId: userId, trashedAt: { not: null } },
      orderBy: { trashedAt: "desc" },
      select: {
        id: true, name: true, mimeType: true, sizeBytes: true, trashedAt: true,
        originalFolderId: true, folderId: true, updatedAt: true,
        trashedBy: { select: { name: true } },
      },
    }),
    db.fileFolder.findMany({
      where: { ownerId: userId, trashedAt: { not: null } },
      orderBy: { trashedAt: "desc" },
      select: { id: true, name: true, trashedAt: true, parentId: true, updatedAt: true, trashedBy: { select: { name: true } } },
    }),
  ]);
  return ok({ view: "trash", files, folders });
}

const FILE_ACTIONS = new Set([
  "FILE_UPLOADED", "FILE_VIEWED", "FILE_DOWNLOADED", "FILE_RENAMED", "FILE_MOVED",
  "FILE_COPIED", "FILE_DELETED", "FILE_RESTORED", "FILE_VERSION_CREATED", "FILE_VERSION_RESTORED",
  "FILE_SHARED", "FILE_SHARE_REVOKED", "FOLDER_CREATED", "FOLDER_UPDATED", "FOLDER_DELETED", "FOLDER_RESTORED",
]);

/** Recent (§24) — REAL audit activity, newest first, deduped per resource. */
async function listRecent(req: NextRequest, userId: string) {
  const { pageSize } = listQuery(req);
  const logs = await db.auditLog.findMany({
    where: { actorId: userId, action: { in: [...FILE_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    take: Math.min(120, Math.max(20, pageSize * 2)),
    select: { id: true, action: true, resourceType: true, resourceId: true, metadata: true, createdAt: true },
  });
  const seen = new Set<string>();
  const recent: { id: string; action: string; name: string; at: string; resourceType: string; resourceId: string }[] = [];
  for (const log of logs) {
    if (seen.has(`${log.resourceType}:${log.resourceId}`)) continue;
    if (recent.length >= 25) break;
    seen.add(`${log.resourceType}:${log.resourceId}`);
    let name = "";
    try { name = (JSON.parse(log.metadata || "{}") as { name?: string }).name ?? ""; } catch { /* ignore */ }
    recent.push({ id: log.id, action: log.action, name, at: log.createdAt.toISOString(), resourceType: log.resourceType, resourceId: log.resourceId });
  }
  return ok({ view: "recent", recent });
}

/** Search (§22/§56) — server-side scoped. Scope = my files ∪ granted files ∪
 *  files inside granted folder trees; folders similarly. */
async function search(url: URL, userId: string) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const mime = url.searchParams.get("mime") ?? "";
  const ext = (url.searchParams.get("ext") ?? "").toLowerCase().slice(0, 12);
  const from = url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : null;
  const to = url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : null;
  const minSize = Number(url.searchParams.get("minSize") ?? "");
  const maxSize = Number(url.searchParams.get("maxSize") ?? "");

  // 1) Own files/folders (no trashed).
  // 2) Direct FILE grants.
  const directFileGrants = await db.fileShare.findMany({
    where: { targetType: "FILE", sharedWithId: userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { targetId: true },
  });
  // 3) FOLDER grants → expand descendants → their files.
  const folderGrants = await db.fileShare.findMany({
    where: { targetType: "FOLDER", sharedWithId: userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { targetId: true },
  });
  const inheritedFolderIds: string[] = [];
  for (const g of folderGrants.slice(0, 200)) {
    inheritedFolderIds.push(g.targetId, ...(await descendantFolderIds(g.targetId, (await db.fileFolder.findUnique({ where: { id: g.targetId }, select: { ownerId: true } }))?.ownerId ?? "")));
  }

  const fileWhere = {
    trashedAt: null,
    AND: [
      { OR: [{ ownerId: userId }, { id: { in: directFileGrants.map((g) => g.targetId) } }, { folderId: { in: inheritedFolderIds } }] },
      q ? { name: { contains: q } } : {},
      mime ? { mimeType: { contains: mime } } : {},
      ext ? { name: { endsWith: `.${ext}` } } : {},
      from ? { createdAt: { gte: from } } : {},
      to ? { createdAt: { lte: to } } : {},
      Number.isFinite(minSize) && minSize > 0 ? { sizeBytes: { gte: minSize } } : {},
      Number.isFinite(maxSize) && maxSize > 0 ? { sizeBytes: { lte: maxSize } } : {},
    ].filter((c) => Object.keys(c).length > 0),
  };
  const [files, folders] = await Promise.all([
    db.fileEntry.findMany({
      where: fileWhere,
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true, name: true, mimeType: true, sizeBytes: true, updatedAt: true, createdAt: true,
        ownerId: true, owner: { select: { id: true, name: true } },
      },
    }),
    q
      ? db.fileFolder.findMany({
          where: {
            trashedAt: null,
            OR: [{ ownerId: userId }, { id: { in: [folderGrants.map((g) => g.targetId), ...inheritedFolderIds].flat() } }],
            name: { contains: q },
          },
          orderBy: { name: "asc" },
          take: 50,
          select: { id: true, name: true, updatedAt: true, ownerId: true, owner: { select: { id: true, name: true } } },
        })
      : Promise.resolve([]),
  ]);
  return ok({ view: "search", files, folders });
}

async function userNameMap(ids: string[]): Promise<Map<string, { id: string; name: string }>> {
  const unique = [...new Set(ids)].filter(Boolean).slice(0, 200);
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u]));
}
