// MOHD.HMS ENTERPRISE — Files dashboard (§5). REAL PostgreSQL aggregates only —
// every number below comes from the database or the object store; nothing is
// simulated. Private to the caller (their own private space stats).

import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { assertRolePermission, usedBytes, userQuotaMb } from "@/lib/hms/files/service";

export const GET = handler(
  async ({ user }) => {
    assertRolePermission(user, PERMISSIONS.files_read);
    const since = new Date(Date.now() - 7 * 86_400_000);

    const [
      filesCount, foldersCount, sharedWithMeCount, sharedFoldersCount,
      trashFiles, trashFolders, starredCount, activeUploads,
      used, quotaMb, recentUploads, recentActivity,
    ] = await Promise.all([
      db.fileEntry.count({ where: { ownerId: user.id, trashedAt: null } }),
      db.fileFolder.count({ where: { ownerId: user.id, trashedAt: null } }),
      db.fileShare.count({ where: { sharedWithId: user.id, targetType: "FILE", revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
      db.fileShare.count({ where: { sharedWithId: user.id, targetType: "FOLDER", revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
      db.fileEntry.count({ where: { ownerId: user.id, trashedAt: { not: null } } }),
      db.fileFolder.count({ where: { ownerId: user.id, trashedAt: { not: null } } }),
      db.fileStar.count({ where: { userId: user.id } }),
      db.fileUploadSession.count({ where: { userId: user.id, status: "PENDING" } }),
      usedBytes(user.id),
      userQuotaMb(),
      db.fileEntry.findMany({
        where: { ownerId: user.id, trashedAt: null },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, name: true, sizeBytes: true, mimeType: true, createdAt: true },
      }),
      db.auditLog.findMany({
        where: { actorId: user.id, action: { in: ["FILE_UPLOADED", "FILE_DOWNLOADED", "FILE_RENAMED", "FILE_SHARED", "FILE_DELETED", "FILE_RESTORED", "FOLDER_CREATED"] }, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, action: true, resourceId: true, metadata: true, createdAt: true },
      }),
    ]);

    const activity = recentActivity.map((a) => {
      let name = "";
      try { name = (JSON.parse(a.metadata || "{}") as { name?: string }).name ?? ""; } catch { /* ignore */ }
      return { id: a.id, action: a.action, name, at: a.createdAt.toISOString(), resourceId: a.resourceId };
    });

    return ok({
      totals: {
        files: filesCount,
        folders: foldersCount,
        usedBytes: used,
        quotaBytes: quotaMb * 1024 * 1024,
        quotaMb,
        sharedWithMe: sharedWithMeCount,
        sharedFolders: sharedFoldersCount,
        starred: starredCount,
        trash: trashFiles + trashFolders,
        uploadQueue: activeUploads,
      },
      recentUploads,
      recentActivity: activity,
    });
  },
  { permission: PERMISSIONS.files_read },
);
