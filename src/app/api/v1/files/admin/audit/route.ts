// MOHD.HMS ENTERPRISE — Admin file audit search (§26/§49).
// GET /api/v1/files/admin/audit — paginated search over the EXISTING audit log
// (user / action / resource / date / result). files.audit permission required.

import { NextRequest } from "next/server";
import { handler, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { assertRolePermission } from "@/lib/hms/files/service";

export const GET = handler(
  async ({ req, user }) => {
    assertRolePermission(user, PERMISSIONS.files_audit);
    const { page, pageSize } = listQuery(req);
    const url = new URL((req as NextRequest).url);
    const action = url.searchParams.get("action")?.trim().slice(0, 80) ?? "";
    const actor = url.searchParams.get("actor")?.trim().slice(0, 120) ?? "";
    const q = url.searchParams.get("q")?.trim().slice(0, 120) ?? "";
    const from = url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : null;
    const to = url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : null;

    const actions = action ? [action] : [
      "FILE_UPLOADED", "FILE_VIEWED", "FILE_DOWNLOADED", "FILE_RENAMED", "FILE_MOVED",
      "FILE_COPIED", "FILE_DELETED", "FILE_RESTORED", "FILE_PERMANENTLY_DELETED",
      "FILE_VERSION_CREATED", "FILE_VERSION_RESTORED", "FILE_SHARED", "FILE_SHARE_REVOKED",
      "FILE_STARRED", "FILE_UNSTARRED", "UPLOAD_STARTED", "UPLOAD_COMPLETED", "UPLOAD_FAILED",
      "FOLDER_CREATED", "FOLDER_UPDATED", "FOLDER_DELETED", "FOLDER_RESTORED", "FOLDER_COPIED",
      "FOLDER_PERMANENTLY_DELETED", "FILE_QUOTA_UPDATED",
    ];

    const where = {
      action: { in: actions },
      ...(actor ? { actorEmail: { contains: actor } } : {}),
      ...(q ? { OR: [{ resourceId: { contains: q } }, { metadata: { contains: q } }] } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, action: true, actorEmail: true, actorId: true, resourceType: true, resourceId: true, metadata: true, ip: true, createdAt: true },
      }),
      db.auditLog.count({ where }),
    ]);
    return okList(rows, pagedMeta(page, pageSize, total));
  },
  { permission: PERMISSIONS.files_audit },
);
