// MOHD.HMS ENTERPRISE — Expense workflow: approve (PENDING→APPROVED) | mark_paid (APPROVED→PAID,
// creates EXPENSE ledger transaction and debits the cash/bank account)

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";

const bodySchema = z.object({
  action: z.enum(["approve", "mark_paid"]),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const body = await parseBody(req, bodySchema);
    const expense = await db.expense.findUnique({ where: { id } });
    if (!expense) throw Errors.notFound("Expense not found.");

    if (body.action === "approve") {
      if (expense.status !== "PENDING") {
        throw Errors.invalidTransition(`Cannot approve an expense in status ${expense.status}.`);
      }
      const updated = await db.expense.update({
        where: { id },
        data: { status: "APPROVED", approvedById: user.id },
        include: { supplier: { select: { id: true, code: true, name: true } } },
      });
      await audit({
        actorId: user.id, actorEmail: user.email, action: "EXPENSE_APPROVED",
        resourceType: "EXPENSE", resourceId: id,
        metadata: { code: expense.code, amountCents: expense.amountCents },
      });
      return ok(updated);
    }

    // mark_paid
    if (expense.status !== "APPROVED") {
      throw Errors.invalidTransition(`Only approved expenses can be marked as paid (current status: ${expense.status}).`);
    }

    // Cash first, bank fallback; no account → ledger entry without account linkage.
    const cash = await db.account.findUnique({ where: { code: "ACC-CASH" } });
    const bank = cash ? null : await db.account.findUnique({ where: { code: "ACC-BANK" } });
    const account = cash ?? bank;
    const trxCode = await nextNumber("TRX");

    const updated = await db.$transaction(async (tx) => {
      const paid = await tx.expense.update({
        where: { id },
        data: { status: "PAID" },
        include: { supplier: { select: { id: true, code: true, name: true } } },
      });
      if (account) {
        await tx.account.update({ where: { id: account.id }, data: { balanceCents: { decrement: expense.amountCents } } });
      }
      await tx.transaction.create({
        data: {
          code: trxCode,
          type: "EXPENSE",
          category: expense.category,
          description: expense.description || `Expense ${expense.code}`,
          amountCents: expense.amountCents,
          accountId: account?.id ?? null,
          date: new Date(),
          referenceType: "EXPENSE",
          referenceId: expense.id,
          createdById: user.id,
        },
      });
      return paid;
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "EXPENSE_PAID",
      resourceType: "EXPENSE", resourceId: id,
      metadata: { code: expense.code, amountCents: expense.amountCents, transactionCode: trxCode, accountId: account?.id ?? null },
    });

    return ok(updated);
  }, { permission: PERMISSIONS.finance_manage })(req);
}
