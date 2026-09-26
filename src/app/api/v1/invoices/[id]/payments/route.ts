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
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";
import { formatCurrency, toCents } from "@/lib/hms/format";
import { applyPaymentToInvoice } from "@/lib/hms/finance/payments";

const bodySchema = z.object({
  amount: z.coerce.number().positive("Payment amount must be greater than 0"),
  // BIBD | BAIDURI (Brunei local banks) are proof-only customer methods but are
  // also selectable by staff when recording a payment directly (spec §21).
  method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "CHEQUE", "ONLINE", "BIBD", "BAIDURI"]),
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
    dedupeSubmission({ userId: user.id, route: `POST /api/v1/invoices/${id}/payments`, body });
    const invoice = await loadScoped(id, user);

    if (invoice.status === "CANCELLED") throw Errors.invalidTransition("Cannot record payments on a cancelled invoice.");
    if (invoice.status === "DRAFT") throw Errors.invalidTransition("Send the invoice before recording payments.");
    if (invoice.balanceCents <= 0) throw Errors.conflict("This invoice is already fully paid.");

    const amountCents = toCents(body.amount);
    if (amountCents > invoice.balanceCents) {
      throw Errors.badRequest(`Payment exceeds the outstanding balance of ${formatCurrency(invoice.balanceCents / 100)}.`);
    }

    // Codes are generated outside the write transaction (SQLite single-writer safety).
    const payCode = await nextNumber("PAY");
    const trxCode = await nextNumber("TRX");
    const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();

    // Single atomic transaction: Payment row (status RECORDED — immediately
    // effective) + invoice paid/balance/status + bank credit + ledger entry
    // + the transactional outbox (payment event + customer receipt email).
    // The settlement math is the SHARED helper also used when Finance confirms
    // a customer payment proof (src/lib/hms/finance/payments.ts).
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

      const { invoice: saved } = await applyPaymentToInvoice(tx, {
        invoiceId: invoice.id,
        invoiceCode: invoice.code,
        amountCents,
        paymentId: payment.id,
        paymentCode: payment.code,
        paidAt,
        actorId: user.id,
        trxCode,
      });

      // Transactional outbox (§27/§29/§69): the payment event + customer
      // receipt email commit WITH the settlement — a payment can never be
      // recorded while its automation is lost (or vice versa).
      await emit({
        type: EVENT_TYPES.PAYMENT_RECEIVED, resourceType: "INVOICE", resourceId: invoice.id,
        payload: { code: invoice.code, amountCents, method: body.method, paidCents: saved.paidCents, balanceCents: saved.balanceCents },
        actorType: "USER", actorId: user.id, tx,
      });
      const payPortalUser = await tx.customer.findUnique({ where: { id: invoice.customerId }, select: { portalUser: { select: { id: true } } } });
      if (payPortalUser?.portalUser?.id) {
        await emit({ type: EVENT_TYPES.EMAIL_SEND, resourceType: "INVOICE", resourceId: invoice.id, payload: { userId: payPortalUser.portalUser.id, title: `Payment received for ${invoice.code}`, message: `Payment of ${formatCurrency(body.amount)} received for invoice ${invoice.code}. Thank you.` }, actorType: "USER", actorId: user.id, tx });
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
      message: `${formatCurrency(body.amount)} (${body.method}) recorded on invoice ${invoice.code}. Balance: ${formatCurrency(updated.balanceCents / 100)}.`,
      type: "SUCCESS",
      resourceType: "INVOICE",
      resourceId: invoice.id,
    });
    // Outbox events (PAYMENT_RECEIVED + customer receipt email) are emitted
    // INSIDE the settlement transaction above — not after commit.
    return ok(updated, 201);
  }, { permission: PERMISSIONS.payments_record })(req);
}
