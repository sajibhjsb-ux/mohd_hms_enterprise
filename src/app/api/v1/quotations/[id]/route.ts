// MOHD.HMS ENTERPRISE — Quotation detail: get / update (draft only) / delete (draft only)

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { isStaff } from "@/lib/hms/rbac";
import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/hms/auth";

const customerSelect = { id: true, code: true, companyName: true, contactPerson: true, email: true, phone: true, address: true, city: true } as const;

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

const patchSchema = z.object({
  customerId: z.string().min(1).optional(),
  quotationDate: z.string().nullish(),
  validUntil: z.string().nullish(),
  notes: z.string().nullish(),
  terms: z.string().nullish(),
  discount: z.coerce.number().min(0).optional(),
  shipping: z.coerce.number().min(0).optional(),
  items: z.array(itemSchema).min(1, "At least one line item is required").optional(),
});

function withId(permission: Permission, fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

/** Load a quotation enforcing customer scoping; throws 404 when invisible. */
async function loadScoped(id: string, user: SessionUser) {
  const quotation = await db.quotation.findUnique({
    where: { id },
    include: { items: { orderBy: { id: "asc" } }, customer: { select: customerSelect } },
  });
  if (!quotation) throw Errors.notFound("Quotation not found.");
  if (!isStaff(user.role) && quotation.customerId !== user.customerId) throw Errors.notFound("Quotation not found.");
  return quotation;
}

function computeItem(input: z.infer<typeof itemSchema>) {
  const unitPriceCents = Math.round(input.unitPrice * 100);
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

export const GET = withId(PERMISSIONS.quotations_read, async (id, { user }) => {
  const quotation = await loadScoped(id, user);
  return ok(quotation);
});

export const PATCH = withId(PERMISSIONS.quotations_manage, async (id, { req, user }) => {
  const existing = await loadScoped(id, user);
  if (existing.status !== "DRAFT") throw Errors.invalidTransition("Only draft quotations can be edited.");

  const body = await parseBody(req, patchSchema);
  if (body.customerId && body.customerId !== existing.customerId) {
    const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!customer) throw Errors.notFound("Customer not found.");
  }

  const items = body.items ? body.items.map(computeItem) : existing.items.map((it) => ({
    kind: it.kind,
    itemId: it.itemId,
    description: it.description,
    quantity: it.quantity,
    unit: it.unit,
    unitPriceCents: it.unitPriceCents,
    discountPercent: it.discountPercent,
    taxPercent: it.taxPercent,
    totalCents: it.totalCents,
  }));

  const subtotalCents = items.reduce((s, it) => s + it.totalCents, 0);
  const taxCents = items.reduce((s, it) => s + Math.round((it.totalCents * it.taxPercent) / 100), 0);
  const discountCents = body.discount !== undefined ? Math.round(body.discount * 100) : existing.discountCents;
  const shippingCents = body.shipping !== undefined ? Math.round(body.shipping * 100) : existing.shippingCents;
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents + shippingCents);
  const labourCostCents = items.filter((i) => i.kind === "LABOUR").reduce((s, i) => s + i.totalCents, 0);
  const materialCostCents = items.filter((i) => i.kind === "MATERIAL").reduce((s, i) => s + i.totalCents, 0);

  const data: Prisma.QuotationUncheckedUpdateInput = {
    ...(body.customerId ? { customerId: body.customerId } : {}),
    ...(body.quotationDate !== undefined ? { quotationDate: body.quotationDate ? new Date(body.quotationDate) : new Date() } : {}),
    ...(body.validUntil !== undefined ? { validUntil: body.validUntil ? new Date(body.validUntil) : null } : {}),
    ...(body.notes != null ? { notes: body.notes } : {}),
    ...(body.terms != null ? { terms: body.terms } : {}),
    subtotalCents, taxCents, discountCents, shippingCents, totalCents, labourCostCents, materialCostCents,
  };

  const quotation = await db.$transaction(async (tx) => {
    if (body.items) {
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      await tx.quotationItem.createMany({ data: items.map((it) => ({ ...it, quotationId: id })) });
    }
    return tx.quotation.update({
      where: { id },
      data,
      include: { items: { orderBy: { id: "asc" } }, customer: { select: customerSelect } },
    });
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "QUOTATION_UPDATED",
    resourceType: "QUOTATION", resourceId: id, metadata: { code: existing.code, totalCents },
  });
  return ok(quotation);
});

export const DELETE = withId(PERMISSIONS.quotations_manage, async (id, { user }) => {
  const existing = await loadScoped(id, user);
  if (existing.status !== "DRAFT") throw Errors.conflict("Only draft quotations can be deleted.");

  await db.$transaction(async (tx) => {
    await tx.quotationItem.deleteMany({ where: { quotationId: id } });
    await tx.quotation.delete({ where: { id } });
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "QUOTATION_DELETED",
    resourceType: "QUOTATION", resourceId: id, metadata: { code: existing.code },
  });
  return ok({ deleted: true });
});
