// MOHD.HMS ENTERPRISE — Petty cash reconciliation (spec §39).
//
//   POST /api/v1/finance/petty-cash/reconcile { fundId, countedAmount, note? }
//   GET  /api/v1/finance/petty-cash/reconcile?fundId=...&page=...
//
// A reconciliation NEVER adjusts the fund balance (spec §39): it records what
// was physically counted against the expected book balance and FLAGS any
// difference for review. Differences are investigated by people, not silently
// patched by software.

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { toCents } from "@/lib/hms/format";

const reconcileSchema = z.object({
  fundId: z.string().trim().min(1, "Fund is required"),
  countedAmount: z.coerce.number().min(0, "Counted cash cannot be negative"),
  note: z.string().trim().max(1000).optional(),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, reconcileSchema);

  const fund = await db.pettyCashFund.findUnique({ where: { id: body.fundId }, select: { id: true, code: true, name: true, currentBalanceCents: true } });
  if (!fund) throw Errors.notFound("Petty cash fund not found.");

  const expectedCents = fund.currentBalanceCents;
  const countedCents = toCents(body.countedAmount);
  const differenceCents = countedCents - expectedCents;
  const flagged = differenceCents !== 0;

  const row = await db.pettyCashReconciliation.create({
    data: {
      fundId: fund.id,
      expectedCents,
      countedCents,
      differenceCents,
      flagged,
      note: body.note ?? "",
      createdById: user.id,
    },
    include: { fund: { select: { id: true, code: true, name: true } } },
  });

  // Deliberate: the fund balance is NEVER touched here (spec §39).
  await audit({
    actorId: user.id, actorEmail: user.email, action: "PETTY_CASH_RECONCILED",
    resourceType: "PETTY_CASH_RECONCILIATION", resourceId: row.id,
    metadata: { fundCode: fund.code, expectedCents, countedCents, differenceCents, flagged },
  });

  return ok(row, 201);
}, { permission: PERMISSIONS.finance_manage });

export const GET = handler(async ({ req }) => {
  const q = listQuery(req);
  const sp = new URL(req.url).searchParams;
  const fundId = (sp.get("fundId") ?? "").trim();
  const flaggedParam = (sp.get("flagged") ?? "").trim();

  const where: Prisma.PettyCashReconciliationWhereInput = {
    ...(fundId ? { fundId } : {}),
    ...(flaggedParam === "1" || flaggedParam === "true" ? { flagged: true } : {}),
    ...(flaggedParam === "0" || flaggedParam === "false" ? { flagged: false } : {}),
  };

  const [items, total] = await Promise.all([
    db.pettyCashReconciliation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: q.skip,
      take: q.take,
      include: { fund: { select: { id: true, code: true, name: true } } },
    }),
    db.pettyCashReconciliation.count({ where }),
  ]);

  return okList(items, pagedMeta(q.page, q.pageSize, total));
}, { permission: PERMISSIONS.finance_read });
