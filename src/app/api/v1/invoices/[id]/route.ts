// MOHD.HMS ENTERPRISE — Invoice detail: get / update (draft only) / delete (draft only)

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
  dueDate: z.string().nullish(),
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

/** Load an invoice enforcing customer scoping; throws 404 when invisible. */
async function loadScoped(id: string, user: SessionUser) {
  const invoice = await db.invoice.findUnique({
    where: { id },
    include: {
      items: { orderBy: { id: "asc" } },
      payments: { orderBy: { paidAt: "desc" } },
      customer: { select: customerSelect },
      quotation: { select: { id: true, code: true } },
      workOrders: { select: { id: true, code: true, title: true } },
    },
  });
  if (!invoice) throw Errors.notFound("Invoice not found.");
  if (!isStaff(user.role) && invoice.customerId !== user.customerId) throw Errors.notFound("Invoice not found.");
  return invoice;
}

function computeItem(input: z.infer<typeof itemSchema>) {
  const unitPriceCents = Math.round(input.unitPrice * 100);
  const discountPercent = input.discountPercent ?? 0;
  // NOTE: InvoiceItem has no itemId column (unlike QuotationItem).
  return {
    kind: input.kind,
    description: input.description,
    quantity: input.quantity,
    unit: input.unit && input.unit.trim() ? input.unit.trim() : "pcs",
    unitPriceCents,
    discountPercent,
    taxPercent: input.taxPercent ?? 0,
    totalCents: Math.round(input.quantity * unitPriceCents * (1 - discountPercent / 100)),
  };
}

export const GET = withId(PERMISSIONS.invoices_read, async (id, { user }) => {
  const invoice = await loadScoped(id, user);
  return ok(invoice);
});

export const PATCH = withId(PERMISSIONS.invoices_manage, async (id, { req, user }) => {
  const existing = await loadScoped(id, user);
  if (existing.status !== "DRAFT") throw Errors.invalidTransition("Only draft invoices can be edited.");

  const body = await parseBody(req, patchSchema);
  if (body.customerId && body.customerId !== existing.customerId) {
    const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!customer) throw Errors.notFound("Customer not found.");
  }

  const items = body.items ? body.items.map(computeItem) : existing.items.map((it) => ({
    kind: it.kind,
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

  const data: Prisma.InvoiceUncheckedUpdateInput = {
    ...(body.customerId ? { customerId: body.customerId } : {}),
    ...(body.dueDate !== undefined ? { dueDate: body.dueDate ? new Date(body.dueDate) : null } : {}),
    ...(body.notes != null ? { notes: body.notes } : {}),
    ...(body.terms != null ? { terms: body.terms } : {}),
    subtotalCents, taxCents, discountCents, shippingCents, totalCents,
    balanceCents: Math.max(0, totalCents - existing.paidCents),
  };

  const invoice = await db.$transaction(async (tx) => {
    if (body.items) {
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceItem.createMany({ data: items.map((it) => ({ ...it, invoiceId: id })) });
    }
    return tx.invoice.update({
      where: { id },
      data,
      include: {
        items: { orderBy: { id: "asc" } },
        payments: { orderBy: { paidAt: "desc" } },
        customer: { select: customerSelect },
      },
    });
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "INVOICE_UPDATED",
    resourceType: "INVOICE", resourceId: id, metadata: { code: existing.code, totalCents },
  });
  return ok(invoice);
});

export const DELETE = withId(PERMISSIONS.invoices_manage, async (id, { user }) => {
  const existing = await loadScoped(id, user);
  if (existing.status !== "DRAFT") throw Errors.conflict("Only draft invoices can be deleted.");
  if (existing.payments.length > 0) throw Errors.conflict("Invoices with payments cannot be deleted.");

  await db.$transaction(async (tx) => {
    await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
    await tx.invoice.delete({ where: { id } });
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "INVOICE_DELETED",
    resourceType: "INVOICE", resourceId: id, metadata: { code: existing.code },
  });
  return ok({ deleted: true });
});
