// MOHD.HMS ENTERPRISE — Personal file activity (§25) — REAL audit data.
// "You uploaded invoice.pdf" style feed built from the existing AuditLog —
// the audit system remains the single activity store (no duplicate log).

import { NextRequest } from "next/server";
import { handler, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { assertRolePermission } from "@/lib/hms/files/service";

const ACTIVITY_ACTIONS = [
  "FILE_UPLOADED", "FILE_VIEWED", "FILE_DOWNLOADED", "FILE_RENAMED", "FILE_MOVED",
  "FILE_COPIED", "FILE_DELETED", "FILE_RESTORED", "FILE_PERMANENTLY_DELETED",
  "FILE_VERSION_CREATED", "FILE_VERSION_RESTORED", "FILE_SHARED", "FILE_SHARE_REVOKED",
  "FILE_STARRED", "FILE_UNSTARRED", "UPLOAD_STARTED", "UPLOAD_COMPLETED", "UPLOAD_FAILED",
  "FOLDER_CREATED", "FOLDER_UPDATED", "FOLDER_DELETED", "FOLDER_RESTORED", "FOLDER_COPIED", "FOLDER_PERMANENTLY_DELETED",
];

export const GET = handler(
  async ({ req, user }) => {
    assertRolePermission(user, PERMISSIONS.files_read);
    const { page, pageSize } = listQuery(req);
    const action = new URL(req.url).searchParams.get("action") ?? "";

    const where = {
      actorId: user.id,
      action: action && ACTIVITY_ACTIONS.includes(action) ? action : { in: ACTIVITY_ACTIONS },
    };
    const [rows, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, action: true, resourceType: true, resourceId: true, metadata: true, ip: true, createdAt: true },
      }),
      db.auditLog.count({ where }),
    ]);
    const items = rows.map((r) => {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(r.metadata || "{}") as Record<string, unknown>; } catch { /* ignore */ }
      return {
        id: r.id, action: r.action, resourceType: r.resourceType, resourceId: r.resourceId,
        name: typeof meta.name === "string" ? meta.name : "",
        detail: meta, ip: r.ip || null, at: r.createdAt.toISOString(),
      };
    });
    return okList(items, pagedMeta(page, pageSize, total));
  },
  { permission: PERMISSIONS.files_read },
);
