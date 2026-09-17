// MOHD.HMS ENTERPRISE — Record a payment against an invoice (single atomic transaction:
// Payment + invoice paid/balance/status + bank account credit + INCOME ledger transaction)

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber, notifyRole } from "@/lib/hms/services";
import { isStaff } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";

const bodySchema = z.object({
  amount: z.coerce.number().positive("Payment amount must be greater than 0"),
  method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "CHEQUE", "ONLINE"]),
  reference: z.string().trim().optional(),
  paidAt: z.string().optional(),
  note: z.string().optional(),
});

async function loadScoped(id: string, user: SessionUser) {
  const invoice = await db.invoice.findUnique({
    where: { id },
    include: { customer: { select: { id: true, code: true, companyName: true } } },
  });
  if (!invoice) throw Errors.notFound("Invoice not found.");
  if (!isStaff(user.role) && invoice.customerId !== user.customerId) throw Errors.notFound("Invoice not found.");
  return invoice;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const body = await parseBody(req, bodySchema);
    const invoice = await loadScoped(id, user);

    if (invoice.status === "CANCELLED") throw Errors.invalidTransition("Cannot record payments on a cancelled invoice.");
    if (invoice.status === "DRAFT") throw Errors.invalidTransition("Send the invoice before recording payments.");
    if (invoice.balanceCents <= 0) throw Errors.conflict("This invoice is already fully paid.");

    const amountCents = Math.round(body.amount * 100);
    if (amountCents > invoice.balanceCents) {
      throw Errors.badRequest(`Payment exceeds the outstanding balance of RM ${(invoice.balanceCents / 100).toFixed(2)}.`);
    }

    // Codes are generated outside the write transaction (SQLite single-writer safety).
    const payCode = await nextNumber("PAY");
    const trxCode = await nextNumber("TRX");
    const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();

    const updated = await db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          code: payCode,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          amountCents,
          method: body.method,
          reference: body.reference ?? "",
          paidAt,
          note: body.note ?? "",
          recordedById: user.id,
        },
      });

      const paidCents = invoice.paidCents + amountCents;
      const balanceCents = Math.max(0, invoice.totalCents - paidCents);
      const status = balanceCents === 0 ? "PAID" : paidCents > 0 ? "PARTIALLY_PAID" : invoice.status;

      const saved = await tx.invoice.update({
        where: { id: invoice.id },
        data: { paidCents, balanceCents, status },
        include: {
          items: { orderBy: { id: "asc" } },
          payments: { orderBy: { paidAt: "desc" } },
          customer: { select: { id: true, code: true, companyName: true, contactPerson: true, email: true, phone: true, address: true, city: true } },
        },
      });

      // Credit the bank account + ledger entry (best-effort inside the same tx).
      const bank = await tx.account.findUnique({ where: { code: "ACC-BANK" } });
      if (bank) {
        await tx.account.update({ where: { id: bank.id }, data: { balanceCents: { increment: amountCents } } });
        await tx.transaction.create({
          data: {
            code: trxCode,
            type: "INCOME",
            category: "SERVICE_INCOME",
            description: `Payment ${invoice.code}`,
            amountCents,
            accountId: bank.id,
            date: paidAt,
            referenceType: "PAYMENT",
            referenceId: payment.id,
            createdById: user.id,
          },
        });
      }

      return saved;
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "PAYMENT_RECORDED",
      resourceType: "INVOICE", resourceId: invoice.id,
      metadata: { invoiceCode: invoice.code, paymentCode: payCode, amountCents, method: body.method },
    });
    await notifyRole("FINANCE", {
      title: `Payment recorded for ${invoice.code}`,
      message: `RM ${body.amount.toFixed(2)} (${body.method}) recorded on invoice ${invoice.code}. Balance: RM ${(updated.balanceCents / 100).toFixed(2)}.`,
      type: "SUCCESS",
      resourceType: "INVOICE",
      resourceId: invoice.id,
    });

    return ok(updated, 201);
  }, { permission: PERMISSIONS.payments_record })(req);
}
