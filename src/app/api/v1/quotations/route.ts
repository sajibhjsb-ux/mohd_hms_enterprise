// MOHD.HMS ENTERPRISE — Quotations: list + create (module agent 6-e)

import { NextRequest } from "next/server";
import { z } from "zod";
import { toCents } from "@/lib/hms/format";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { nextNumber, audit } from "@/lib/hms/services";
import { isStaff, scopeFilter } from "@/lib/hms/rbac";
import type { Prisma } from "@prisma/client";

// ── Shared document math (mirror exactly in UI previews) ──
// item.totalCents = round(qty × unitPriceCents × (1 − disc%/100))
// subtotal = Σ item totals; taxCents = Σ round(itemTotal × tax%/100)
// total = max(0, subtotal − discountCents + taxCents + shippingCents)

type DocItemInput = {
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

function computeItem(input: DocItemInput): ComputedItem {
  const unitPriceCents = toCents(input.unitPrice);
  const discountPercent = input.discountPercent ?? 0;
  const totalCents = Math.round(input.quantity * unitPriceCents * (1 - discountPercent / 100));
  return {
    kind: input.kind,
    itemId: input.itemId ?? null,
    description: input.description,
    quantity: input.quantity,
    unit: input.unit && input.unit.trim() ? input.unit.trim() : "pcs",
    unitPriceCents,
    discountPercent,
    taxPercent: input.taxPercent ?? 0,
    totalCents,
  };
}

function computeDocTotals(items: ComputedItem[], discount: number, shipping: number) {
  const subtotalCents = items.reduce((s, it) => s + it.totalCents, 0);
  const taxCents = items.reduce((s, it) => s + Math.round((it.totalCents * it.taxPercent) / 100), 0);
  const discountCents = toCents(discount);
  const shippingCents = toCents(shipping);
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents + shippingCents);
  const labourCostCents = items.filter((i) => i.kind === "LABOUR").reduce((s, i) => s + i.totalCents, 0);
  const materialCostCents = items.filter((i) => i.kind === "MATERIAL").reduce((s, i) => s + i.totalCents, 0);
  return { subtotalCents, taxCents, discountCents, shippingCents, totalCents, labourCostCents, materialCostCents };
}

// ── Schemas ──

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

const createSchema = z.object({
  customerId: z.string().min(1, "Customer is required"),
  quotationDate: z.string().optional(),
  validUntil: z.string().nullish(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  discount: z.coerce.number().min(0).optional(),
  shipping: z.coerce.number().min(0).optional(),
  items: z.array(itemSchema).min(1, "At least one line item is required"),
});

const customerSelect = { id: true, code: true, companyName: true, contactPerson: true, email: true, phone: true } as const;

// ── GET /api/v1/quotations ──

export const GET = handler(async ({ req, user }) => {
  const { page, pageSize, skip, take, search, status, customerId } = listQuery(req);
  const where: Prisma.QuotationWhereInput = {
    ...scopeFilter(user.role, user.customerId),
    ...(status ? { status } : {}),
    ...(!isStaff(user.role) ? {} : customerId ? { customerId } : {}),
    ...(search ? { code: { contains: search } } : {}),
  };
  const [items, total] = await Promise.all([
    db.quotation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: { customer: { select: customerSelect } },
    }),
    db.quotation.count({ where }),
  ]);
  return okList(items, pagedMeta(page, pageSize, total));
}, { permission: PERMISSIONS.quotations_read });

// ── POST /api/v1/quotations ──

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);

  const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: customerSelect });
  if (!customer) throw Errors.notFound("Customer not found.");

  const items = body.items.map(computeItem);
  const totals = computeDocTotals(items, body.discount ?? 0, body.shipping ?? 0);
  const code = await nextNumber("QTN");

  const quotation = await db.quotation.create({
    data: {
      code,
      customerId: body.customerId,
      quotationDate: body.quotationDate ? new Date(body.quotationDate) : new Date(),
      validUntil: body.validUntil ? new Date(body.validUntil) : null,
      status: "DRAFT",
      ...totals,
      notes: body.notes ?? "",
      terms: body.terms ?? "",
      createdById: user.id,
      items: { create: items.map((it) => ({ ...it })) },
    },
    include: { items: true, customer: { select: customerSelect } },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "QUOTATION_CREATED",
    resourceType: "QUOTATION",
    resourceId: quotation.id,
    metadata: { code, totalCents: totals.totalCents, customerId: body.customerId },
  });

  return ok(quotation, 201);
}, { permission: PERMISSIONS.quotations_manage });
