// MOHD.HMS ENTERPRISE — Quotation → Invoice conversion (APPROVED → CONVERTED)

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";
import { isStaff } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";

const customerSelect = { id: true, code: true, companyName: true, contactPerson: true, email: true, phone: true, address: true, city: true } as const;

async function loadScoped(id: string, user: SessionUser) {
  const quotation = await db.quotation.findUnique({
    where: { id },
    include: { items: { orderBy: { id: "asc" } } },
  });
  if (!quotation) throw Errors.notFound("Quotation not found.");
  if (!isStaff(user.role) && quotation.customerId !== user.customerId) throw Errors.notFound("Quotation not found.");
  return quotation;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    void req;
    const quotation = await loadScoped(id, user);
    if (quotation.status !== "APPROVED") {
      throw Errors.invalidTransition(`Only approved quotations can be converted (current status: ${quotation.status}).`);
    }

    const invoiceCode = await nextNumber("INV");
    const now = new Date();
    const dueDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const invoice = await db.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          code: invoiceCode,
          customerId: quotation.customerId,
          quotationId: quotation.id,
          invoiceDate: now,
          dueDate,
          status: "DRAFT",
          subtotalCents: quotation.subtotalCents,
          discountCents: quotation.discountCents,
          taxCents: quotation.taxCents,
          shippingCents: quotation.shippingCents,
          totalCents: quotation.totalCents,
          paidCents: 0,
          balanceCents: quotation.totalCents,
          notes: quotation.notes,
          terms: quotation.terms,
          createdById: user.id,
          items: {
            create: quotation.items.map((it) => ({
              kind: it.kind,
              description: it.description,
              quantity: it.quantity,
              unit: it.unit,
              unitPriceCents: it.unitPriceCents,
              discountPercent: it.discountPercent,
              taxPercent: it.taxPercent,
              // identical math to quotation items
              totalCents: Math.round(it.quantity * it.unitPriceCents * (1 - it.discountPercent / 100)),
            })),
          },
        },
        include: { items: { orderBy: { id: "asc" } }, customer: { select: customerSelect } },
      });
      await tx.quotation.update({
        where: { id: quotation.id },
        data: { status: "CONVERTED", convertedInvoiceId: created.id },
      });
      return created;
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "QUOTATION_CONVERTED",
      resourceType: "QUOTATION", resourceId: quotation.id,
      metadata: { code: quotation.code, invoiceCode: invoice.code, invoiceId: invoice.id },
    });

    return ok(invoice, 201);
  }, { permission: PERMISSIONS.quotations_manage })(req);
}
