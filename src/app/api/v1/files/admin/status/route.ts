// MOHD.HMS ENTERPRISE — File system status (§30/§12 admin view).
// Real object-storage health + authoritative counts. files.manage_storage only.

import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { storage } from "@/lib/hms/storage";
import { assertRolePermission, userQuotaMb } from "@/lib/hms/files/service";

export const GET = handler(
  async ({ user }) => {
    assertRolePermission(user, PERMISSIONS.files_manage_storage);
    const [health, sessions, quotaMb] = await Promise.all([
      storage.healthCheck(),
      db.fileUploadSession.findMany({
        where: { status: "PENDING", updatedAt: { gte: new Date(Date.now() - 3600_000) } },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: { id: true, name: true, sizeBytes: true, totalChunks: true, receivedChunks: true, updatedAt: true, user: { select: { name: true, email: true } } },
      }),
      userQuotaMb(),
    ]);
    return ok({
      storage: health, // { ok, error? } — real bucket connectivity check
      bucket: storage.bucket,
      quotaMb,
      activeUploadSessions: sessions,
    });
  },
  { permission: PERMISSIONS.files_manage_storage },
);
