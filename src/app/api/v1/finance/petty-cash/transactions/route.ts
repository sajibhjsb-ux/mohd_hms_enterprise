// MOHD.HMS ENTERPRISE — Petty cash transactions (spec §34-§36).
//
//   GET  /api/v1/finance/petty-cash/transactions         — filtered list (finance_read)
//   POST /api/v1/finance/petty-cash/transactions         — submit new PENDING transaction (finance_manage)
//
// Direction is SERVER-DERIVED from the type (spec §34):
//   CASH_IN / TOP_UP → IN;  CASH_OUT / EXPENSE / REIMBURSEMENT → OUT;
//   ADJUSTMENT → caller-chosen (default OUT).
// A transaction NEVER moves the fund balance here — balances move only on
// approval (spec §35).

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { nextNumber, audit } from "@/lib/hms/services";
import { toCents } from "@/lib/hms/format";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";

const TX_TYPES = ["CASH_IN", "CASH_OUT", "TOP_UP", "EXPENSE", "REIMBURSEMENT", "ADJUSTMENT"] as const;
const IN_TYPES = new Set<string>(["CASH_IN", "TOP_UP"]);

/** Server-side direction derivation (spec §34) — the client never decides. */
function deriveDirection(type: string, requested?: string): "IN" | "OUT" {
  if (type === "ADJUSTMENT") return requested === "IN" ? "IN" : "OUT";
  return IN_TYPES.has(type) ? "IN" : "OUT";
}

// ── GET /api/v1/finance/petty-cash/transactions ──

export const GET = handler(async ({ req }) => {
  const q = listQuery(req);
  const sp = new URL(req.url).searchParams;
  const fundId = (sp.get("fundId") ?? "").trim();
  const type = (sp.get("type") ?? "").trim().toUpperCase();
  const status = (sp.get("status") ?? "").trim().toUpperCase();
  const month = (sp.get("month") ?? "").trim(); // YYYY-MM
  const requesterId = (sp.get("requesterId") ?? "").trim();

  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    throw Errors.badRequest("Month filter must use the YYYY-MM format.");
  }

  const where: Prisma.PettyCashTransactionWhereInput = {
    ...(fundId ? { fundId } : {}),
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(requesterId ? { requesterId } : {}),
    ...(month
      ? {
          txDate: {
            gte: new Date(`${month}-01T00:00:00.000Z`),
            lt: new Date(
              new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString()
            ),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.pettyCashTransaction.findMany({
      where,
      orderBy: [{ txDate: "desc" }, { createdAt: "desc" }],
      skip: q.skip,
      take: q.take,
      include: { fund: { select: { id: true, code: true, name: true } } },
    }),
    db.pettyCashTransaction.count({ where }),
  ]);

  return okList(items, pagedMeta(q.page, q.pageSize, total));
}, { permission: PERMISSIONS.finance_read });

// ── POST /api/v1/finance/petty-cash/transactions ──

const createSchema = z.object({
  fundId: z.string().trim().min(1, "Fund is required"),
  type: z.enum(TX_TYPES),
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  category: z.string().trim().max(80).optional(),
  description: z.string().trim().max(500).optional(),
  txDate: z.string().optional(),
  requesterId: z.string().trim().min(1).nullish(),
  reference: z.string().trim().max(120).optional(),
  // Accepted ONLY for ADJUSTMENT (spec §34) — every other type is derived.
  direction: z.enum(["IN", "OUT"]).optional(),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);
  dedupeSubmission({ userId: user.id, route: "POST /api/v1/finance/petty-cash/transactions", body });

  if (body.direction && body.type !== "ADJUSTMENT") {
    throw Errors.badRequest("Direction is only accepted for ADJUSTMENT transactions — every other type is derived from the type.");
  }
  const description = body.description ?? "";
  if ((body.type === "EXPENSE" || body.type === "REIMBURSEMENT") && description.length < 1) {
    throw Errors.badRequest("Description is required for EXPENSE and REIMBURSEMENT transactions.");
  }

  const fund = await db.pettyCashFund.findUnique({ where: { id: body.fundId }, select: { id: true, code: true, name: true, status: true } });
  if (!fund) throw Errors.notFound("Petty cash fund not found.");
  if (fund.status !== "ACTIVE") {
    throw Errors.invalidTransition("This fund is inactive — reactivate it before recording transactions.");
  }

  // Resolve the requester: an explicit staff pick, else the submitting user.
  let requesterName = user.name ?? "";
  if (body.requesterId) {
    const requester = await db.user.findUnique({ where: { id: body.requesterId }, select: { id: true, name: true, status: true } });
    if (!requester) throw Errors.badRequest("Requester not found.");
    requesterName = requester.name;
  }

  const amountCents = toCents(body.amount);
  if (amountCents <= 0) throw Errors.badRequest("Amount must be greater than 0.");

  const code = await nextNumber("PCT");
  const tx = await db.pettyCashTransaction.create({
    data: {
      code,
      fundId: fund.id,
      type: body.type,
      direction: deriveDirection(body.type, body.direction),
      amountCents,
      category: body.category?.trim() ? body.category.trim() : body.type === "EXPENSE" || body.type === "REIMBURSEMENT" ? "GENERAL" : "CASH",
      description,
      txDate: body.txDate ? new Date(body.txDate) : new Date(),
      requesterId: body.requesterId ?? user.id,
      requesterName,
      reference: body.reference ?? "",
      status: "PENDING",
      createdById: user.id,
    },
    include: { fund: { select: { id: true, code: true, name: true } } },
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "PETTY_CASH_TX_CREATED",
    resourceType: "PETTY_CASH_TRANSACTION", resourceId: tx.id,
    metadata: { code, fundCode: fund.code, type: tx.type, direction: tx.direction, amountCents },
  });

  return ok(tx, 201);
}, { permission: PERMISSIONS.finance_manage });
