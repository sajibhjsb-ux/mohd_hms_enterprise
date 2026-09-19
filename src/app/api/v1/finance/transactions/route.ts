// MOHD.HMS ENTERPRISE — Finance ledger transactions: filterable list (type / month / search)

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { Prisma } from "@prisma/client";

export const GET = handler(async ({ req }) => {
  const { page, pageSize, skip, take, search, status: type } = listQuery(req);
  const month = new URL(req.url).searchParams.get("month") ?? ""; // YYYY-MM

  let dateFilter: Prisma.DateTimeFilter | undefined;
  if (/^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-").map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 1);
    dateFilter = { gte: start, lt: end };
  }

  const where: Prisma.TransactionWhereInput = {
    ...(type === "INCOME" || type === "EXPENSE" ? { type } : {}),
    ...(dateFilter ? { date: dateFilter } : {}),
    ...(search
      ? {
          OR: [
            { code: { contains: search } },
            { description: { contains: search } },
            { category: { contains: search } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip,
      take,
      include: { account: { select: { id: true, code: true, name: true, type: true } } },
    }),
    db.transaction.count({ where }),
  ]);

  return okList(items, pagedMeta(page, pageSize, total));
}, { permission: PERMISSIONS.finance_read });
