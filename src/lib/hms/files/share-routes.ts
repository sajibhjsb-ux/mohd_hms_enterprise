// MOHD.HMS ENTERPRISE — Sharing system (§13/§27/§53). ONE implementation used
// by both file and folder routes. Grants are exact (VIEW ⊆ DOWNLOAD ⊆ EDIT ⊆
// MANAGE); revocation is immediate because every access re-checks the grant;
// recipients are notified through the existing NotificationService.

import "server-only";
import { handler, ok, parseBody, Errors, listQuery } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { Permission } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { notify } from "@/lib/hms/services";
import {
  assertRolePermission, normalizeSharePermission, grantHolderIds, emitFilesUpdated,
  canAccessFile, canAccessFolder, withParams, type ShareTargetType, type SharePermission,
} from "@/lib/hms/files/service";

const grantSchema = z.object({
  userId: z.string().min(1).max(64),
  permission: z.string().max(16),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export function makeShareHandlers(targetType: ShareTargetType, rolePermission: Permission) {
  const resourceType = targetType === "FILE" ? "FILE" : "FILE_FOLDER";
  const label = targetType === "FILE" ? "File" : "Folder";

  /** GET — list active grants (owner or MANAGE holders only). */
  const listShares = withParams<{ id: string }>(
    async ({ user, params }) => {
      const { id } = params;
      assertRolePermission(user, rolePermission);
      const access = targetType === "FILE" ? await canAccessFile(user, id, "VIEW") : await canAccessFolder(user, id, "VIEW");
      const canManage = access.isOwner || access.level === "MANAGE";
      if (!canManage) throw Errors.forbidden("Only the owner can view sharing settings.");

      const rows = await db.fileShare.findMany({
        where: { targetType, targetId: id, revokedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, sharedWithId: true, permission: true, expiresAt: true, createdAt: true,
          sharedWith: { select: { id: true, name: true, email: true } },
          sharedBy: { select: { id: true, name: true } },
        },
      });
      return ok({ shares: rows });
    },
    { permission: rolePermission },
  );

  /** POST — grant a user an exact permission (§13). Owner or MANAGE holder. */
  const createShare = withParams<{ id: string }>(
    async ({ req, user, params }) => {
      const { id } = params;
      assertRolePermission(user, rolePermission);
      const body = await parseBody(req, grantSchema);
      const permission = normalizeSharePermission(body.permission);
      const access = targetType === "FILE" ? await canAccessFile(user, id, "MANAGE") : await canAccessFolder(user, id, "MANAGE");

      const target = targetType === "FILE"
        ? await db.fileEntry.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, trashedAt: true } })
        : await db.fileFolder.findUnique({ where: { id }, select: { id: true, name: true, ownerId: true, trashedAt: true } });
      if (!target || target.trashedAt) throw Errors.notFound(`${label} not found.`);

      const recipient = await db.user.findUnique({ where: { id: body.userId }, select: { id: true, name: true, email: true, status: true } });
      if (!recipient || recipient.status !== "ACTIVE") throw Errors.badRequest("Recipient user not found or not active.");
      if (recipient.id === target.ownerId) throw Errors.badRequest("The owner already has full access.");

      if (body.expiresAt) {
        const exp = new Date(body.expiresAt);
        if (Number.isNaN(exp.getTime()) || exp.getTime() <= Date.now()) throw Errors.badRequest("Expiry must be in the future.");
      }

      const share = await db.$transaction(async (tx) => {
        // Re-grant replaces a revoked row (unique per target+user): reuse if a
        // revoked row exists, else create.
        const existing = await tx.fileShare.findUnique({
          where: { targetType_targetId_sharedWithId: { targetType, targetId: id, sharedWithId: recipient.id } },
        });
        if (existing) {
          return tx.fileShare.update({
            where: { id: existing.id },
            data: { permission, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, revokedAt: null, revokedById: null, sharedById: user.id },
          });
        }
        return tx.fileShare.create({
          data: {
            targetType, targetId: id, sharedById: user.id, sharedWithId: recipient.id,
            permission, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          },
        });
      });

      void audit({
        actorId: user.id, actorEmail: user.email, action: "FILE_SHARED", resourceType, resourceId: id,
        metadata: { name: target.name, targetType, permission, sharedWith: recipient.email, expiresAt: share.expiresAt?.toISOString() ?? null },
      });
      void notify({
        userId: recipient.id,
        title: `${label} shared with you`,
        message: `${user.name} shared “${target.name}” with you (${permission.toLowerCase()} access${share.expiresAt ? `, expires ${share.expiresAt.toLocaleDateString()}` : ""}).`,
        type: "INFO",
        resourceType, resourceId: id,
        channels: ["IN_APP"],
      });
      await emitFilesUpdated([...(await grantHolderIds(targetType, id)), user.id], resourceType, id);
      return ok({ share: { id: share.id, permission: share.permission, expiresAt: share.expiresAt, sharedWith: { id: recipient.id, name: recipient.name, email: recipient.email } } }, 201);
    },
    { permission: rolePermission },
  );

  return { listShares, createShare };
}

/** DELETE …/shares/{shareId} — revoke (§13: recipient loses access IMMEDIATELY). */
export function makeShareRevokeHandler(targetType: ShareTargetType, rolePermission: Permission) {
  const resourceType = targetType === "FILE" ? "FILE" : "FILE_FOLDER";
  const label = targetType === "FILE" ? "File" : "Folder";

  return withParams<{ id: string; shareId: string }>(
    async ({ user, params }) => {
      const { id, shareId } = params;
      assertRolePermission(user, rolePermission);
      const access = targetType === "FILE" ? await canAccessFile(user, id, "MANAGE") : await canAccessFolder(user, id, "MANAGE");
      void access;

      const share = await db.fileShare.findUnique({
        where: { id: shareId },
        select: { id: true, targetType: true, targetId: true, sharedWithId: true, sharedWith: { select: { name: true, email: true } }, revokedAt: true },
      });
      if (!share || share.targetType !== targetType || share.targetId !== id) throw Errors.notFound("Share not found.");
      if (share.revokedAt) return ok({ revoked: true });

      await db.fileShare.update({ where: { id: share.id }, data: { revokedAt: new Date(), revokedById: user.id } });

      void audit({
        actorId: user.id, actorEmail: user.email, action: "FILE_SHARE_REVOKED", resourceType, resourceId: id,
        metadata: { targetType, revokedFrom: share.sharedWith.email },
      });
      void notify({
        userId: share.sharedWithId,
        title: `${label} share revoked`,
        message: `${user.name} revoked your access to “${(targetType === "FILE" ? (await db.fileEntry.findUnique({ where: { id }, select: { name: true } }))?.name : (await db.fileFolder.findUnique({ where: { id }, select: { name: true } }))?.name) ?? label}”.`,
        type: "WARNING",
        resourceType, resourceId: id,
        channels: ["IN_APP"],
      });
      await emitFilesUpdated([share.sharedWithId, user.id], resourceType, id);
      return ok({ revoked: true });
    },
    { permission: rolePermission },
  );
}

/** GET /files/share-targets?q= — minimal user picker for the share dialog (§13).
 *  Returns only ACTIVE users' id/name/email — no other profile data. */
export const shareTargetsHandler = handler(
  async ({ req, user }) => {
    assertRolePermission(user, PERMISSIONS.files_share);
    const { pageSize } = listQuery(req);
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 80);
    const users = await db.user.findMany({
      where: {
        status: "ACTIVE",
        id: { not: user.id },
        ...(q
          ? {
              OR: [
                { name: { contains: q } },
                { email: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: { name: "asc" },
      take: Math.min(25, Math.max(5, pageSize)),
      select: { id: true, name: true, email: true, role: true },
    });
    return ok({ users });
  },
  { permission: PERMISSIONS.files_share },
);

/** Star toggle factory (§23) — POST …/star toggles the caller's own star. */
export function makeStarHandler(targetType: ShareTargetType) {
  const resourceType = targetType === "FILE" ? "FILE" : "FILE_FOLDER";
  return withParams<{ id: string }>(
    async ({ user, params }) => {
      const { id } = params;
      // Starring requires access (§23); both owners and grantees may star.
      if (targetType === "FILE") await canAccessFile(user, id, "VIEW");
      else await canAccessFolder(user, id, "VIEW");

      const existing = await db.fileStar.findUnique({
        where: { userId_targetType_targetId: { userId: user.id, targetType, targetId: id } },
      });
      if (existing) {
        await db.fileStar.delete({ where: { id: existing.id } });
        void audit({ actorId: user.id, actorEmail: user.email, action: "FILE_UNSTARRED", resourceType, resourceId: id, metadata: { targetType } });
        return ok({ starred: false });
      }
      await db.fileStar.create({ data: { userId: user.id, targetType, targetId: id } });
      void audit({ actorId: user.id, actorEmail: user.email, action: "FILE_STARRED", resourceType, resourceId: id, metadata: { targetType } });
      return ok({ starred: true });
    }, { permission: PERMISSIONS.files_read });
}

// keep SharePermission import referenced (route type docs)
export type { SharePermission };
