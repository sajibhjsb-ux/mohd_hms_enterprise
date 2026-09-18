// MOHD.HMS ENTERPRISE — Expenses: list + create (PENDING approval workflow)

import { NextRequest } from "next/server";
import { z } from "zod";
import { toCents } from "@/lib/hms/format";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { nextNumber, audit } from "@/lib/hms/services";
import type { Prisma } from "@prisma/client";

const createSchema = z.object({
  category: z.string().trim().min(1, "Category is required"),
  description: z.string().trim().min(1, "Description is required"),
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  expenseDate: z.string().optional(),
  supplierId: z.string().min(1).nullish(),
  receiptNo: z.string().trim().optional(),
});

// ── GET /api/v1/finance/expenses ──

export const GET = handler(async ({ req }) => {
  const { page, pageSize, skip, take, search, status } = listQuery(req);
  const where: Prisma.ExpenseWhereInput = {
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { code: { contains: search } },
            { description: { contains: search } },
            { category: { contains: search } },
            { receiptNo: { contains: search } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    db.expense.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: { supplier: { select: { id: true, code: true, name: true } } },
    }),
    db.expense.count({ where }),
  ]);
  return okList(items, pagedMeta(page, pageSize, total));
}, { permission: PERMISSIONS.finance_read });

// ── POST /api/v1/finance/expenses ──

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);

  if (body.supplierId) {
    const supplier = await db.supplier.findUnique({ where: { id: body.supplierId }, select: { id: true } });
    if (!supplier) throw Errors.notFound("Supplier not found.");
  }

  const code = await nextNumber("EXP");
  const expense = await db.expense.create({
    data: {
      code,
      category: body.category,
      description: body.description,
      amountCents: toCents(body.amount),
      expenseDate: body.expenseDate ? new Date(body.expenseDate) : new Date(),
      supplierId: body.supplierId ?? null,
      receiptNo: body.receiptNo ?? "",
      status: "PENDING",
      createdById: user.id,
    },
    include: { supplier: { select: { id: true, code: true, name: true } } },
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "EXPENSE_CREATED",
    resourceType: "EXPENSE", resourceId: expense.id,
    metadata: { code, amountCents: expense.amountCents, category: expense.category },
  });

  return ok(expense, 201);
}, { permission: PERMISSIONS.finance_manage });
