// MOHD.HMS ENTERPRISE — Stock movement ledger (newest first).

import { db } from "@/lib/db";
import { handler, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const itemId = (sp.get("itemId") ?? "").trim();
    const type = (sp.get("type") ?? "").trim();

    const where = {
      ...(itemId ? { itemId } : {}),
      ...(type ? { type } : {}),
    };

    const [movements, total] = await Promise.all([
      db.stockMovement.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: q.skip,
        take: q.take,
        include: { item: { select: { sku: true, name: true, unit: true } } },
      }),
      db.stockMovement.count({ where }),
    ]);

    return okList(movements, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.inventory_read }
);
