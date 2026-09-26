// MOHD.HMS ENTERPRISE — Petty cash transaction workflow (spec §35-§36).
//
//   POST /api/v1/finance/petty-cash/transactions/{id}/transition { action: approve | reject, note? }
//
// BALANCES MOVE ONLY ON APPROVAL (spec §35), inside ONE Prisma transaction:
//   fund balance → PettyCashTransaction(APPROVED, balanceAfterCents) →
//   ACC-CASH mirror + ledger Transaction row (best-effort, same tx).
// Segregation of duties: nobody approves their own submission unless they are
// ADMIN/SUPER_ADMIN (spec §36).

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";
import { money } from "@/lib/hms/format";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";

const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ req, user }) => {
    const body = await parseBody(req, bodySchema);
    dedupeSubmission({ userId: user.id, route: `POST /api/v1/finance/petty-cash/transactions/${id}/transition`, body: { id, action: body.action } });

    const tx = await db.pettyCashTransaction.findUnique({
      where: { id },
      include: { fund: { select: { id: true, code: true, name: true } } },
    });
    if (!tx) throw Errors.notFound("Petty cash transaction not found.");

    if (body.action === "reject") {
      if (tx.status !== "PENDING") {
        throw Errors.invalidTransition(`Cannot reject a transaction in status ${tx.status}.`);
      }
      const note = (body.note ?? "").trim();
      if (note.length < 5) {
        throw Errors.badRequest("A review note of at least 5 characters is required to reject a transaction.");
      }
      const rejected = await db.$transaction(async (prisma) => {
        const claim = await prisma.pettyCashTransaction.updateMany({
          where: { id: tx.id, status: "PENDING" },
          data: { status: "REJECTED", approvedById: user.id, approvedAt: new Date(), reviewNote: note },
        });
        if (claim.count !== 1) {
          const cur = await prisma.pettyCashTransaction.findUnique({ where: { id: tx.id }, select: { status: true } });
          throw Errors.invalidTransition(`Cannot reject a transaction in status ${cur?.status ?? "UNKNOWN"}.`);
        }
        return (await prisma.pettyCashTransaction.findUnique({
          where: { id: tx.id },
          include: { fund: { select: { id: true, code: true, name: true } } },
        }))!;
      });
      await audit({
        actorId: user.id, actorEmail: user.email, action: "PETTY_CASH_TX_REJECTED",
        resourceType: "PETTY_CASH_TRANSACTION", resourceId: tx.id,
        metadata: { code: tx.code, amountCents: tx.amountCents, note },
      });
      return ok(rejected);
    }

    // ── approve ──
    if (tx.status !== "PENDING") {
      throw Errors.invalidTransition(`Cannot approve a transaction in status ${tx.status}.`);
    }

    // Segregation of duties (spec §36): the creator cannot approve their own
    // submission — unless they are ADMIN/SUPER_ADMIN.
    const isPrivilegedApprover = user.role === "SUPER_ADMIN" || user.role === "ADMIN";
    if (tx.createdById === user.id && !isPrivilegedApprover) {
      throw Errors.forbidden("You cannot approve your own petty cash transaction.");
    }

    const trxCode = await nextNumber("TRX");
    const delta = tx.direction === "IN" ? tx.amountCents : -tx.amountCents;

    const { fund } = tx;
    if (!fund) throw Errors.notFound("Petty cash fund for this transaction no longer exists.");

    const result = await db.$transaction(async (prisma) => {
      const current = await prisma.pettyCashFund.findUnique({
        where: { id: fund.id },
        select: { currentBalanceCents: true },
      });
      if (!current) throw Errors.notFound("Petty cash fund for this transaction no longer exists.");

      const newBalance = current.currentBalanceCents + delta;
      if (newBalance < 0) {
        throw Errors.invalidTransition(
          `Insufficient fund balance in ${fund.code} — available ${money(current.currentBalanceCents)}, requested ${money(tx.amountCents)}.`
        );
      }

      // 0) Claim the transition: only one reviewer can move PENDING → APPROVED,
      //    so two concurrent approvals can never double-pay the fund.
      const claim = await prisma.pettyCashTransaction.updateMany({
        where: { id: tx.id, status: "PENDING" },
        data: {
          status: "APPROVED",
          approvedById: user.id,
          approvedAt: new Date(),
          balanceAfterCents: newBalance,
          ...(body.note?.trim() ? { reviewNote: body.note.trim() } : {}),
        },
      });
      if (claim.count !== 1) {
        const cur = await prisma.pettyCashTransaction.findUnique({ where: { id: tx.id }, select: { status: true } });
        throw Errors.invalidTransition(`Cannot approve a transaction in status ${cur?.status ?? "UNKNOWN"}.`);
      }

      // 1) The money moves: fund balance + immutable snapshot on the tx.
      await prisma.pettyCashFund.update({
        where: { id: fund.id },
        data: { currentBalanceCents: newBalance },
      });
      const approved = (await prisma.pettyCashTransaction.findUnique({ where: { id: tx.id } }))!;

      // 2) Ledger mirror (best-effort, SAME transaction): ACC-CASH moves with
      //    the cash box and an INCOME/EXPENSE row lands in the general ledger.
      try {
        const cash = await prisma.account.findUnique({ where: { code: "ACC-CASH" } });
        if (cash) {
          await prisma.account.update({
            where: { id: cash.id },
            data: { balanceCents: delta >= 0 ? { increment: tx.amountCents } : { decrement: tx.amountCents } },
          });
        }
        await prisma.transaction.create({
          data: {
            code: trxCode,
            type: delta >= 0 ? "INCOME" : "EXPENSE",
            category: tx.category || "PETTY_CASH",
            description: `Petty cash ${tx.code} — ${fund.name}`,
            amountCents: tx.amountCents,
            accountId: cash?.id ?? null,
            date: tx.txDate ?? new Date(),
            referenceType: "PETTY_CASH",
            referenceId: tx.id,
            createdById: user.id,
          },
        });
      } catch (err) {
        // Never block the approval because the mirror hiccupped — but make it loud.
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "petty-cash-ledger-mirror-failed", txId: tx.id, error: String(err) }));
      }

      return { approved, newBalance };
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "PETTY_CASH_TX_APPROVED",
      resourceType: "PETTY_CASH_TRANSACTION", resourceId: tx.id,
      metadata: { code: tx.code, amountCents: tx.amountCents, direction: tx.direction, balanceAfterCents: result.newBalance },
    });

    return ok(result.approved);
  }, { permission: PERMISSIONS.finance_manage })(req);
}
