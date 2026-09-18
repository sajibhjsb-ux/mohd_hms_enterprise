// MOHD.HMS ENTERPRISE — Expense detail: get / update (while PENDING only)

import { NextRequest } from "next/server";
import { z } from "zod";
import { toCents } from "@/lib/hms/format";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

const patchSchema = z.object({
  category: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  amount: z.coerce.number().positive("Amount must be greater than 0").optional(),
  expenseDate: z.string().nullish(),
  supplierId: z.string().min(1).nullish(),
  receiptNo: z.string().trim().nullish(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async () => {
    const expense = await db.expense.findUnique({
      where: { id },
      include: { supplier: { select: { id: true, code: true, name: true } } },
    });
    if (!expense) throw Errors.notFound("Expense not found.");
    return ok(expense);
  }, { permission: PERMISSIONS.finance_read })(req);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const existing = await db.expense.findUnique({ where: { id } });
    if (!existing) throw Errors.notFound("Expense not found.");
    if (existing.status !== "PENDING") throw Errors.invalidTransition("Only pending expenses can be edited.");

    const body = await parseBody(req, patchSchema);
    if (body.supplierId) {
      const supplier = await db.supplier.findUnique({ where: { id: body.supplierId }, select: { id: true } });
      if (!supplier) throw Errors.notFound("Supplier not found.");
    }

    const expense = await db.expense.update({
      where: { id },
      data: {
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.amount !== undefined ? { amountCents: toCents(body.amount) } : {}),
        ...(body.expenseDate !== undefined ? { expenseDate: body.expenseDate ? new Date(body.expenseDate) : new Date() } : {}),
        ...(body.supplierId !== undefined ? { supplierId: body.supplierId ?? null } : {}),
        ...(body.receiptNo !== undefined ? { receiptNo: body.receiptNo ?? "" } : {}),
      },
      include: { supplier: { select: { id: true, code: true, name: true } } },
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "EXPENSE_UPDATED",
      resourceType: "EXPENSE", resourceId: id,
      metadata: { code: existing.code, amountCents: expense.amountCents },
    });

    return ok(expense);
  }, { permission: PERMISSIONS.finance_manage })(req);
}
