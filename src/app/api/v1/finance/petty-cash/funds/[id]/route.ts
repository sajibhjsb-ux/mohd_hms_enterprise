// MOHD.HMS ENTERPRISE — Petty cash fund detail (spec §32-§33).
//
//   GET   /api/v1/finance/petty-cash/funds/{id} — fund + approved aggregates + recent txs + last reconciliations
//   PATCH /api/v1/finance/petty-cash/funds/{id} — update name / custodian / notes / status
//
// Deactivation guard: a fund with PENDING transactions cannot be deactivated —
// settle them first (approve or reject) so the balance can never drift.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

const CUSTODIAN_SELECT = { id: true, name: true, email: true } as const;

async function loadFund(id: string) {
  const fund = await db.pettyCashFund.findUnique({
    where: { id },
    include: { custodian: { select: CUSTODIAN_SELECT } },
  });
  if (!fund) throw Errors.notFound("Petty cash fund not found.");
  return fund;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async () => {
    const fund = await loadFund(id);

    const [dirAgg, recentTxs, recentRecons] = await Promise.all([
      db.pettyCashTransaction.groupBy({
        by: ["direction"],
        where: { fundId: fund.id, status: "APPROVED" },
        _sum: { amountCents: true },
      }),
      db.pettyCashTransaction.findMany({
        where: { fundId: fund.id },
        orderBy: [{ txDate: "desc" }, { createdAt: "desc" }],
        take: 25,
      }),
      db.pettyCashReconciliation.findMany({
        where: { fundId: fund.id },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    const totalInCents = dirAgg.find((r) => r.direction === "IN")?._sum.amountCents ?? 0;
    const totalOutCents = dirAgg.find((r) => r.direction === "OUT")?._sum.amountCents ?? 0;
    const pendingCount = await db.pettyCashTransaction.count({ where: { fundId: fund.id, status: "PENDING" } });

    return ok({
      ...fund,
      totalInCents,
      totalOutCents,
      pendingCount,
      recentTransactions: recentTxs,
      recentReconciliations: recentRecons,
    });
  }, { permission: PERMISSIONS.finance_read })(req);
}

const patchSchema = z.object({
  name: z.string().trim().min(1, "Fund name is required").max(120).optional(),
  custodianId: z.string().trim().min(1).nullish(),
  notes: z.string().trim().max(1000).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ req, user }) => {
    const body = await parseBody(req, patchSchema);
    const fund = await loadFund(id);

    if (body.custodianId) {
      const custodian = await db.user.findUnique({ where: { id: body.custodianId }, select: { id: true, status: true } });
      if (!custodian) throw Errors.badRequest("Custodian not found.");
      if (custodian.status !== "ACTIVE") throw Errors.badRequest("Custodian must be an active staff member.");
    }

    if (body.status === "INACTIVE" && fund.status === "ACTIVE") {
      const pending = await db.pettyCashTransaction.count({ where: { fundId: fund.id, status: "PENDING" } });
      if (pending > 0) {
        throw Errors.conflict("Settle pending transactions first.");
      }
    }

    if (body.name && body.name.trim().toLowerCase() !== fund.name.trim().toLowerCase()) {
      const funds = await db.pettyCashFund.findMany({ select: { id: true, name: true } });
      const duplicate = funds.find((f) => f.id !== fund.id && f.name.trim().toLowerCase() === body.name!.trim().toLowerCase());
      if (duplicate) throw Errors.conflict(`A petty cash fund named "${duplicate.name}" already exists.`);
    }

    const updated = await db.pettyCashFund.update({
      where: { id: fund.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.custodianId !== undefined ? { custodianId: body.custodianId || null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      include: { custodian: { select: CUSTODIAN_SELECT } },
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "PETTY_CASH_FUND_UPDATED",
      resourceType: "PETTY_CASH_FUND", resourceId: fund.id,
      metadata: { code: fund.code, changes: { ...body } },
    });

    return ok(updated);
  }, { permission: PERMISSIONS.finance_manage })(req);
}
