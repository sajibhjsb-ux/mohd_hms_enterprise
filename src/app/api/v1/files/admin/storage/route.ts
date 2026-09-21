// MOHD.HMS ENTERPRISE — File administration: storage (§30/§35/§29).
// GET   — real aggregate storage stats (never exposed to non-admins).
// PATCH — update the per-user quota (Setting key; audited, no secrets).

import { handler, ok, parseBody, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { assertRolePermission, QUOTA_SETTING_KEY, userQuotaMb, userQuotaBytes } from "@/lib/hms/files/service";

export const GET = handler(
  async ({ req, user }) => {
    assertRolePermission(user, PERMISSIONS.files_manage_storage);
    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const pageSize = Math.min(50, Math.max(5, Number(url.searchParams.get("pageSize") ?? "15") || 15));

    // §4 — ONE consistent policy, zero double counting: `FileVersion` is the
    // physical size ledger. activeBytes/trashedBytes are CURRENT-version sums
    // (FileEntry.sizeBytes mirrors the current version); oldVersionBytes is
    // derived as physical − active − trashed so the parts always add up.
    const [agg, trashAgg, physicalAgg, folderCount, quotaMb, quotaBytes] = await Promise.all([
      db.fileEntry.aggregate({ where: { trashedAt: null }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      db.fileEntry.aggregate({ where: { trashedAt: { not: null } }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      db.fileVersion.aggregate({ _count: { _all: true }, _sum: { sizeBytes: true } }),
      db.fileFolder.count({ where: { trashedAt: null } }),
      userQuotaMb(),
      userQuotaBytes(),
    ]);
    const activeBytes = agg._sum.sizeBytes ?? 0;
    const trashedBytes = trashAgg._sum.sizeBytes ?? 0;
    const physicalBytes = physicalAgg._sum.sizeBytes ?? 0;

    // Per-staff usage (§5): physical bytes per owner = Σ of their FileVersion
    // rows, joined through the file→owner map.
    const [fileOwnerRows, versionGroup, perUserRaw] = await Promise.all([
      db.fileEntry.findMany({ select: { id: true, ownerId: true, trashedAt: true, sizeBytes: true } }),
      db.fileVersion.groupBy({ by: ["fileId"], _sum: { sizeBytes: true } }),
      db.user.findMany({
        where: { role: { notIn: ["CUSTOMER"] } },
        select: { id: true, name: true, email: true, role: true, status: true },
        orderBy: { name: "asc" },
      }),
    ]);
    const bytesByFile = new Map(versionGroup.map((v) => [v.fileId, v._sum.sizeBytes ?? 0]));
    const physicalByOwner = new Map<string, number>();
    const trashedByOwner = new Map<string, number>();
    for (const f of fileOwnerRows) {
      physicalByOwner.set(f.ownerId, (physicalByOwner.get(f.ownerId) ?? 0) + (bytesByFile.get(f.id) ?? 0));
      if (f.trashedAt) trashedByOwner.set(f.ownerId, (trashedByOwner.get(f.ownerId) ?? 0) + f.sizeBytes);
    }

    // Every staff member appears (even 0-byte rows) so §5 warnings are complete;
    // sorted by usage desc.
    const allStaff = perUserRaw
      .map((u) => {
        const used = physicalByOwner.get(u.id) ?? 0;
        const available = Math.max(0, quotaBytes - used);
        return {
          userId: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          status: u.status,
          usedBytes: used,
          limitBytes: quotaBytes,
          availableBytes: available,
          percentUsed: quotaBytes > 0 ? Math.min(100, Math.round((used / quotaBytes) * 1000) / 10) : 0,
          // 80 % high · 90 % very high · 100 % reached (spec §5)
          warning: used === 0 ? "OK" : available <= 0 ? "REACHED" : used / quotaBytes >= 0.9 ? "VERY_HIGH" : used / quotaBytes >= 0.8 ? "HIGH" : "OK",
          trashedBytes: trashedByOwner.get(u.id) ?? 0,
        };
      })
      .sort((a, b) => b.usedBytes - a.usedBytes);
    const total = allStaff.length;
    const perUser = allStaff.slice((page - 1) * pageSize, page * pageSize);

    const largest = await db.fileEntry.findMany({
      where: { trashedAt: null },
      orderBy: { sizeBytes: "desc" },
      take: 10,
      select: { id: true, name: true, sizeBytes: true, mimeType: true, updatedAt: true, owner: { select: { id: true, name: true, email: true } } },
    });

    return ok({
      totals: {
        activeFiles: agg._count._all,
        activeBytes,
        trashedFiles: trashAgg._count._all,
        trashedBytes,
        versions: physicalAgg._count._all,
        // physical = active + trashed + old versions — no double counting (§4)
        oldVersionBytes: Math.max(0, physicalBytes - activeBytes - trashedBytes),
        physicalBytes,
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
