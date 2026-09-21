// MOHD.HMS ENTERPRISE — File administration: storage (§30/§35/§29).
// GET   — real aggregate storage stats (never exposed to non-admins).
// PATCH — update the per-user quota (Setting key; audited, no secrets).

import { handler, ok, parseBody, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { assertRolePermission, QUOTA_SETTING_KEY, userQuotaMb } from "@/lib/hms/files/service";

export const GET = handler(
  async ({ req, user }) => {
    assertRolePermission(user, PERMISSIONS.files_manage_storage);
    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const pageSize = Math.min(50, Math.max(5, Number(url.searchParams.get("pageSize") ?? "15") || 15));

    const [agg, trashAgg, versionAgg, folderCount, quotaMb, perUserRaw, largest] = await Promise.all([
      db.fileEntry.aggregate({ where: { trashedAt: null }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      db.fileEntry.aggregate({ where: { trashedAt: { not: null } }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      db.fileVersion.aggregate({ _count: { _all: true }, _sum: { sizeBytes: true } }),
      db.fileFolder.count({ where: { trashedAt: null } }),
      userQuotaMb(),
      db.fileEntry.groupBy({
        by: ["ownerId"],
        where: { trashedAt: null },
        _count: { _all: true },
        _sum: { sizeBytes: true },
        orderBy: { _sum: { sizeBytes: "desc" } },
      }),
      db.fileEntry.findMany({
        where: { trashedAt: null },
        orderBy: { sizeBytes: "desc" },
        take: 10,
        select: { id: true, name: true, sizeBytes: true, mimeType: true, updatedAt: true, owner: { select: { id: true, name: true, email: true } } },
      }),
    ]);

    const ownerIds = perUserRaw.map((r) => r.ownerId);
    const owners = await db.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, name: true, email: true, role: true },
    });
    const ownerById = new Map(owners.map((o) => [o.id, o]));
    const total = perUserRaw.length;
    const perUser = perUserRaw
      .slice((page - 1) * pageSize, page * pageSize)
      .map((r) => ({
        userId: r.ownerId,
        name: ownerById.get(r.ownerId)?.name ?? "Unknown",
        email: ownerById.get(r.ownerId)?.email ?? "",
        role: ownerById.get(r.ownerId)?.role ?? "",
        files: r._count._all,
        usedBytes: r._sum.sizeBytes ?? 0,
      }));

    return ok({
      totals: {
        activeFiles: agg._count._all,
        activeBytes: agg._sum.sizeBytes ?? 0,
        trashedFiles: trashAgg._count._all,
        trashedBytes: trashAgg._sum.sizeBytes ?? 0,
        versions: versionAgg._count._all,
        versionBytes: versionAgg._sum.sizeBytes ?? 0,
        folders: folderCount,
        quotaMb,
      },
      perUser,
      largest,
      meta: pagedMeta(page, pageSize, total),
    });
  },
  { permission: PERMISSIONS.files_manage_storage },
);

const quotaSchema = z.object({ quotaMb: z.number().int().min(1).max(1_000_000) });

export const PATCH = handler(
  async ({ req, user }) => {
    assertRolePermission(user, PERMISSIONS.files_manage_storage);
    const body = await parseBody(req, quotaSchema);
    const previous = await userQuotaMb();
    await db.setting.upsert({
      where: { key: QUOTA_SETTING_KEY },
      update: { value: String(body.quotaMb) },
      create: { key: QUOTA_SETTING_KEY, value: String(body.quotaMb) },
    });
    void audit({
      actorId: user.id, actorEmail: user.email, action: "FILE_QUOTA_UPDATED", resourceType: "FILE_CONFIG", resourceId: "quota",
      metadata: { previousQuotaMb: previous, newQuotaMb: body.quotaMb },
    });
    return ok({ quotaMb: body.quotaMb });
  },
  { permission: PERMISSIONS.files_manage_storage },
);
