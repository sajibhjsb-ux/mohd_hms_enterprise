// MOHD.HMS ENTERPRISE — Petty cash funds (spec §31-§33).
//
//   GET  /api/v1/finance/petty-cash/funds  — list funds + custodian + aggregates (finance_read)
//   POST /api/v1/finance/petty-cash/funds  — create fund (finance_manage)
//
// Money is stored as integer cents. The fund opens with currentBalanceCents =
// openingBalanceCents; balances move ONLY when transactions are approved.

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { nextNumber, audit } from "@/lib/hms/services";
import { toCents } from "@/lib/hms/format";

const CUSTODIAN_SELECT = { id: true, name: true, email: true } as const;

// ── GET /api/v1/finance/petty-cash/funds ──

export const GET = handler(async ({ req }) => {
  const q = listQuery(req);
  const sp = new URL(req.url).searchParams;
  const status = (sp.get("fundStatus") ?? "").trim().toUpperCase();

  const where: Prisma.PettyCashFundWhereInput = {
    ...(status ? { status } : {}),
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search } },
            { code: { contains: q.search } },
          ],
        }
      : {}),
  };

  const [items, total, dirAgg, pendingRows, allRows] = await Promise.all([
    db.pettyCashFund.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: q.skip,
      take: q.take,
      include: { custodian: { select: CUSTODIAN_SELECT } },
    }),
    db.pettyCashFund.count({ where }),
    // Approved IN/OUT totals per fund — drives the fund cards' aggregates.
    db.pettyCashTransaction.groupBy({
      by: ["fundId", "direction"],
      where: { status: "APPROVED" },
      _sum: { amountCents: true },
    }),
    db.pettyCashTransaction.groupBy({
      by: ["fundId"],
      where: { status: "PENDING" },
      _count: { _all: true },
    }),
    db.pettyCashTransaction.groupBy({
      by: ["fundId"],
      _count: { _all: true },
    }),
  ]);

  const inByFund = new Map<string, number>();
  const outByFund = new Map<string, number>();
  for (const row of dirAgg) {
    if (row.direction === "IN") inByFund.set(row.fundId, row._sum.amountCents ?? 0);
    else outByFund.set(row.fundId, row._sum.amountCents ?? 0);
  }
  const pendingByFund = new Map(pendingRows.map((r) => [r.fundId, r._count._all]));
  const countByFund = new Map(allRows.map((r) => [r.fundId, r._count._all]));

  return okList(
    items.map((f) => ({
      ...f,
      totalInCents: inByFund.get(f.id) ?? 0,
      totalOutCents: outByFund.get(f.id) ?? 0,
      pendingCount: pendingByFund.get(f.id) ?? 0,
      transactionCount: countByFund.get(f.id) ?? 0,
    })),
    pagedMeta(q.page, q.pageSize, total)
  );
}, { permission: PERMISSIONS.finance_read });

// ── POST /api/v1/finance/petty-cash/funds ──

const createSchema = z.object({
  name: z.string().trim().min(1, "Fund name is required").max(120),
  openingBalance: z.coerce.number().min(0, "Opening balance cannot be negative"),
  custodianId: z.string().trim().min(1).nullish(),
  notes: z.string().trim().max(1000).optional(),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);

  if (body.custodianId) {
    const custodian = await db.user.findUnique({ where: { id: body.custodianId }, select: { id: true, name: true, status: true } });
    if (!custodian) throw Errors.badRequest("Custodian not found.");
    if (custodian.status !== "ACTIVE") throw Errors.badRequest("Custodian must be an active staff member.");
  }

  const name = body.name;
  // Case-insensitive duplicate-name guard.
  const funds = await db.pettyCashFund.findMany({ select: { id: true, name: true } });
  const duplicate = funds.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (duplicate) {
    throw Errors.conflict(`A petty cash fund named "${duplicate.name}" already exists.`);
  }

  const openingCents = toCents(body.openingBalance);
  if (openingCents < 0) throw Errors.badRequest("Opening balance cannot be negative.");

  const code = await nextNumber("PCF");
  const fund = await db.pettyCashFund.create({
    data: {
      code,
      name,
      openingBalanceCents: openingCents,
      currentBalanceCents: openingCents,
      custodianId: body.custodianId ?? null,
      notes: body.notes ?? "",
      status: "ACTIVE",
      createdById: user.id,
    },
    include: { custodian: { select: CUSTODIAN_SELECT } },
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "PETTY_CASH_FUND_CREATED",
    resourceType: "PETTY_CASH_FUND", resourceId: fund.id,
    metadata: { code, name, openingBalanceCents: openingCents, custodianId: fund.custodianId },
  });

  return ok(fund, 201);
}, { permission: PERMISSIONS.finance_manage });
