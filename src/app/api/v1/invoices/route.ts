// MOHD.HMS ENTERPRISE — Invoices: list (with overdue sweep) + create (manual | from work order)

import { NextRequest } from "next/server";
import { z } from "zod";
import { toCents } from "@/lib/hms/format";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { nextNumber, audit } from "@/lib/hms/services";
import { isStaff, scopeFilter } from "@/lib/hms/rbac";
import type { Prisma } from "@prisma/client";

// ── Shared document math (identical to quotations) ──

type ItemInput = {
  kind: string;
  itemId?: string | null;
  description: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  discountPercent?: number;
  taxPercent?: number;
};

type ComputedItem = {
  kind: string;
  itemId: string | null;
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  discountPercent: number;
  taxPercent: number;
  totalCents: number;
};

function computeItem(input: ItemInput): ComputedItem {
  const unitPriceCents = toCents(input.unitPrice);
  const discountPercent = input.discountPercent ?? 0;
  return {
    kind: input.kind,
    itemId: input.itemId ?? null,
    description: input.description,
    quantity: input.quantity,
    unit: input.unit && input.unit.trim() ? input.unit.trim() : "pcs",
    unitPriceCents,
    discountPercent,
    taxPercent: input.taxPercent ?? 0,
    totalCents: Math.round(input.quantity * unitPriceCents * (1 - discountPercent / 100)),
  };
}

function computeDocTotals(items: ComputedItem[], discount: number, shipping: number) {
  const subtotalCents = items.reduce((s, it) => s + it.totalCents, 0);
  const taxCents = items.reduce((s, it) => s + Math.round((it.totalCents * it.taxPercent) / 100), 0);
  const discountCents = toCents(discount);
  const shippingCents = toCents(shipping);
  return {
    subtotalCents, taxCents, discountCents, shippingCents,
    totalCents: Math.max(0, subtotalCents - discountCents + taxCents + shippingCents),
  };
}

const itemSchema = z.object({
  kind: z.enum(["MATERIAL", "LABOUR", "SERVICE", "CUSTOM"]),
  itemId: z.string().min(1).nullish(),
  description: z.string().trim().min(1, "Description is required"),
  quantity: z.coerce.number().positive("Quantity must be greater than 0"),
  unit: z.string().trim().min(1).optional(),
  unitPrice: z.coerce.number().min(0, "Unit price cannot be negative"),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  taxPercent: z.coerce.number().min(0).max(100).optional(),
});

const manualSchema = z.object({
  customerId: z.string().min(1, "Customer is required"),
  invoiceDate: z.string().optional(),
  dueDate: z.string().nullish(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  discount: z.coerce.number().min(0).optional(),
  shipping: z.coerce.number().min(0).optional(),
  items: z.array(itemSchema).min(1, "At least one line item is required"),
});

const fromWoSchema = z.object({
  workOrderId: z.string().min(1, "Work order is required"),
  dueDate: z.string().nullish(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  discount: z.coerce.number().min(0).optional(),
  shipping: z.coerce.number().min(0).optional(),
});

const customerSelect = { id: true, code: true, companyName: true, contactPerson: true, email: true, phone: true } as const;
const OPEN_STATUSES = ["SENT", "PARTIALLY_PAID", "OVERDUE"];

function startOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// ── GET /api/v1/invoices ──

export const GET = handler(async ({ req, user }) => {
  // Sweep: any SENT invoice past its due date becomes OVERDUE before querying.
  await db.invoice.updateMany({
    where: { status: "SENT", dueDate: { lt: new Date() } },
    data: { status: "OVERDUE" },
  });

  const { page, pageSize, skip, take, search, status, customerId } = listQuery(req);
  const scope = scopeFilter(user.role, user.customerId);
  const where: Prisma.InvoiceWhereInput = {
    ...scope,
    ...(status ? { status } : {}),
    ...(isStaff(user.role) && customerId ? { customerId } : {}),
    ...(search ? { code: { contains: search } } : {}),
  };

  const [items, total, overdueAgg, outstandingAgg, paidThisMonthAgg] = await Promise.all([
    db.invoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: { customer: { select: customerSelect } },
    }),
    db.invoice.count({ where }),
    db.invoice.aggregate({ where: { ...scope, status: "OVERDUE" }, _count: { _all: true } }),
    db.invoice.aggregate({ where: { ...scope, status: { in: OPEN_STATUSES } }, _sum: { balanceCents: true } }),
    db.payment.aggregate({
      where: { paidAt: { gte: startOfMonth() }, ...(scope.customerId ? { customerId: scope.customerId } : {}) },
      _sum: { amountCents: true },
    }),
  ]);

  return okList(items, {
    ...pagedMeta(page, pageSize, total),
    overdueCount: overdueAgg._count._all,
    outstandingCents: outstandingAgg._sum.balanceCents ?? 0,
    paidThisMonthCents: paidThisMonthAgg._sum.amountCents ?? 0,
  });
}, { permission: PERMISSIONS.invoices_read });

// ── POST /api/v1/invoices ──

export const POST = handler(async ({ req, user }) => {
  const raw = await req.clone().json().catch(() => null) as Record<string, unknown> | null;
  const fromWorkOrder = !!raw && typeof raw === "object" && typeof raw.workOrderId === "string" && raw.workOrderId.length > 0;

  if (fromWorkOrder) {
    const body = await parseBody(req, fromWoSchema);
    const wo = await db.workOrder.findUnique({
      where: { id: body.workOrderId },
      include: { materials: true, customer: { select: customerSelect } },
    });
    if (!wo) throw Errors.notFound("Work order not found.");
    if (wo.status !== "COMPLETED") throw Errors.invalidTransition("Only completed work orders can be invoiced.");
    if (wo.invoiceId) throw Errors.conflict("This work order has already been invoiced.");

    const items: ComputedItem[] = [];
    if (wo.labourHours > 0) {
      items.push(computeItem({
        kind: "LABOUR",
        description: `Labour — ${wo.title}`,
        quantity: wo.labourHours,
        unit: "hr",
        unitPrice: wo.labourRateCents / 100,
        taxPercent: 6,
      }));
    }
    for (const m of wo.materials) {
      items.push(computeItem({
        kind: "MATERIAL",
        itemId: m.inventoryItemId,
        description: m.name,
        quantity: m.quantity,
        unit: m.unit,
        unitPrice: m.unitCostCents / 100,
        taxPercent: 6,
      }));
    }
    if (items.length === 0) throw Errors.badRequest("Work order has no billable labour or materials.");

    const totals = computeDocTotals(items, body.discount ?? 0, body.shipping ?? 0);
    const code = await nextNumber("INV");
    const now = new Date();
    const dueDate = body.dueDate ? new Date(body.dueDate) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const invoice = await db.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          code,
          customerId: wo.customerId,
          workOrderId: wo.id,
          complaintId: wo.complaintId,
          invoiceDate: now,
          dueDate,
          status: "DRAFT",
          ...totals,
          paidCents: 0,
          balanceCents: totals.totalCents,
          notes: body.notes ?? "",
          terms: body.terms ?? "",
          createdById: user.id,
          // InvoiceItem has no itemId column — strip it before persisting.
          items: { create: items.map(({ itemId: _ignored, ...rest }) => rest) },
        },
        include: { items: true, customer: { select: customerSelect } },
      });
      // Link the work order so it cannot be invoiced twice.
      await tx.workOrder.update({ where: { id: wo.id }, data: { invoiceId: created.id } });
      return created;
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "INVOICE_CREATED",
      resourceType: "INVOICE", resourceId: invoice.id,
      metadata: { code, source: "WORK_ORDER", workOrderId: wo.id, totalCents: totals.totalCents },
    });
    return ok(invoice, 201);
  }

  // Manual invoice
  const body = await parseBody(req, manualSchema);
  const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: customerSelect });
  if (!customer) throw Errors.notFound("Customer not found.");

  const items = body.items.map(computeItem);
  const totals = computeDocTotals(items, body.discount ?? 0, body.shipping ?? 0);
  const code = await nextNumber("INV");
  const now = new Date();
  const dueDate = body.dueDate ? new Date(body.dueDate) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const invoice = await db.invoice.create({
    data: {
      code,
      customerId: body.customerId,
      invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : now,
      dueDate,
      status: "DRAFT",
      ...totals,
      paidCents: 0,
      balanceCents: totals.totalCents,
      notes: body.notes ?? "",
      terms: body.terms ?? "",
      createdById: user.id,
      // InvoiceItem has no itemId column — strip it before persisting.
      items: { create: items.map(({ itemId: _ignored, ...rest }) => rest) },
    },
    include: { items: true, customer: { select: customerSelect } },
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "INVOICE_CREATED",
    resourceType: "INVOICE", resourceId: invoice.id,
    metadata: { code, source: "MANUAL", totalCents: totals.totalCents, customerId: body.customerId },
  });
  return ok(invoice, 201);
}, { permission: PERMISSIONS.invoices_manage });
