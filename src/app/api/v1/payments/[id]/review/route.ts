// MOHD.HMS ENTERPRISE — Payment proof review (spec §27/§28).
//
//   POST /api/v1/payments/{id}/review   body: { action, reason? }
//     action: "confirm"       — proof is genuine: payment ON_HOLD → PAID, the
//                               invoice balance settles and the bank account
//                               is credited (same shared helper as the staff
//                               payment path — money moves in ONE transaction).
//     action: "reject"        — proof rejected (reason REQUIRED, min 5 chars):
//                               payment → REJECTED, invoice untouched, the
//                               customer may resubmit a new proof.
//     action: "request_info"  — Finance asks the customer for details: status
//                               STAYS ON_HOLD, note recorded for the customer.
//
// Permission: payments_record (FINANCE/ADMIN/SUPER_ADMIN — CUSTOMER lacks it
// and gets 403 automatically). Every step is audited + notified.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber, notify, notifyRole } from "@/lib/hms/services";
import { formatCurrency } from "@/lib/hms/format";
import { applyPaymentToInvoice } from "@/lib/hms/finance/payments";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const bodySchema = z.object({
  action: z.enum(["confirm", "reject", "request_info"]),
  reason: z.string().trim().optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const body = await parseBody(req, bodySchema);

    const payment = await db.payment.findUnique({
      where: { id },
      include: {
        invoice: {
          select: {
            id: true, code: true, status: true, totalCents: true, paidCents: true, balanceCents: true,
            customer: { select: { id: true, code: true, companyName: true, portalUser: { select: { id: true } } } },
          },
        },
      },
    });
    if (!payment) throw Errors.notFound("Payment not found.");

    const invoice = payment.invoice;
    const portalUserId = invoice?.customer.portalUser?.id ?? null;
    const notifyCustomer = async (title: string, message: string, type: "INFO" | "SUCCESS" | "WARNING" | "ERROR" = "INFO") => {
      if (portalUserId) {
        await notify({ userId: portalUserId, title, message, type, resourceType: "INVOICE", resourceId: invoice?.id });
      }
    };

    // ── CONFIRM — money actually moves (ON_HOLD → PAID) ─────────────────────
    if (body.action === "confirm") {
      if (payment.status !== "ON_HOLD") {
        throw Errors.invalidTransition(`Only payments awaiting review (ON_HOLD) can be confirmed — this payment is ${payment.status}.`);
      }
      if (!invoice) {
        throw Errors.invalidTransition("This payment is not linked to an invoice and cannot be confirmed.");
      }
      // Honest guard: the invoice may have been settled by other means while
      // the proof sat in the queue — confirming again would double-credit.
      if (invoice.balanceCents <= 0) {
        throw Errors.invalidTransition(`Invoice ${invoice.code} is already fully paid — this proof can no longer be confirmed.`);
      }
      if (payment.amountCents > invoice.balanceCents) {
        throw Errors.invalidTransition(
          `The proof amount (${formatCurrency(payment.amountCents / 100)}) exceeds the current outstanding balance of ${formatCurrency(invoice.balanceCents / 100)} on invoice ${invoice.code}. Reject it and ask the customer to resubmit.`
        );
      }

      const trxCode = await nextNumber("TRX");
      const now = new Date();

      const { invoice: updated } = await db.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: "PAID", reviewedById: user.id, reviewedAt: now },
        });
        return applyPaymentToInvoice(tx, {
          invoiceId: invoice.id,
          invoiceCode: invoice.code,
          totalCents: invoice.totalCents,
          paidCentsBefore: invoice.paidCents,
          statusBefore: invoice.status,
          amountCents: payment.amountCents,
          paymentId: payment.id,
          paymentCode: payment.code,
          paidAt: payment.paidAt ?? now,
          actorId: user.id,
          trxCode,
          description: `Payment ${invoice.code} (proof ${payment.code})`,
        });
      });

      await audit({
        actorId: user.id, actorEmail: user.email, action: "PAYMENT_CONFIRMED",
        resourceType: "INVOICE", resourceId: invoice.id,
        metadata: { invoiceCode: invoice.code, paymentCode: payment.code, amountCents: payment.amountCents, method: payment.method, reviewNote: body.reason ?? "" },
      });
      // Legacy action kept so the invoice timeline shows the settlement.
      await audit({
        actorId: user.id, actorEmail: user.email, action: "PAYMENT_RECORDED",
        resourceType: "INVOICE", resourceId: invoice.id,
        metadata: { invoiceCode: invoice.code, paymentCode: payment.code, amountCents: payment.amountCents, method: payment.method, source: "PROOF_CONFIRMED" },
      });

      await notifyCustomer(
        "Payment confirmed",
        "Your payment has been confirmed.",
        "SUCCESS",
      );
      await notifyRole("FINANCE", {
        title: `Payment confirmed for ${invoice.code}`,
        message: `Proof ${payment.code} (${formatCurrency(payment.amountCents / 100)}) confirmed by ${user.name}. Invoice balance: ${formatCurrency(updated.balanceCents / 100)}.`,
        type: "SUCCESS",
        resourceType: "INVOICE",
        resourceId: invoice.id,
      });

      // Outbox (§27/§29): payment-received event + queued email receipt —
      // identical to the staff-recorded payment path.
      await emit({
        type: EVENT_TYPES.PAYMENT_RECEIVED, resourceType: "INVOICE", resourceId: invoice.id,
        payload: { code: invoice.code, amountCents: payment.amountCents, method: payment.method, paidCents: updated.paidCents, balanceCents: updated.balanceCents, source: "PROOF_CONFIRMED" },
        actorType: "USER", actorId: user.id,
      });
      if (portalUserId) {
        await emit({
          type: EVENT_TYPES.EMAIL_SEND, resourceType: "INVOICE", resourceId: invoice.id,
          payload: { userId: portalUserId, title: `Payment received for ${invoice.code}`, message: `Payment of ${formatCurrency(payment.amountCents / 100)} received for invoice ${invoice.code}. Thank you.` },
          actorType: "USER", actorId: user.id,
        });
      }

      return ok({
        payment: await db.payment.findUnique({ where: { id: payment.id } }),
        invoice: { id: updated.id, code: updated.code, status: updated.status, totalCents: updated.totalCents, paidCents: updated.paidCents, balanceCents: updated.balanceCents },
      });
    }

    // ── REJECT — proof is not acceptable (invoice untouched) ────────────────
    if (body.action === "reject") {
      if (payment.status !== "ON_HOLD") {
        throw Errors.invalidTransition(`Only payments awaiting review (ON_HOLD) can be rejected — this payment is ${payment.status}.`);
      }
      const reason = (body.reason ?? "").trim();
      if (reason.length < 5) {
        throw Errors.badRequest("A rejection reason of at least 5 characters is required.");
      }
      const now = new Date();
      const updated = await db.payment.update({
        where: { id: payment.id },
        data: { status: "REJECTED", reviewedById: user.id, reviewedAt: now, reviewNote: reason },
      });

      await audit({
        actorId: user.id, actorEmail: user.email, action: "PAYMENT_PROOF_REJECTED",
        resourceType: "INVOICE", resourceId: invoice?.id ?? "",
        metadata: { paymentCode: payment.code, invoiceCode: invoice?.code ?? "", amountCents: payment.amountCents, reason },
      });
      await notifyCustomer(
        "Payment proof rejected",
        `Your payment proof has been rejected. Please review the reason. Reason: ${reason}`,
        "WARNING",
      );
      await notifyRole("FINANCE", {
        title: `Payment proof ${payment.code} rejected`,
        message: `Proof ${payment.code} for invoice ${invoice?.code ?? "—"} was rejected by ${user.name}. Reason: ${reason}`,
        type: "WARNING",
        resourceType: "INVOICE",
        resourceId: invoice?.id ?? "",
      });

      return ok({ payment: updated, invoice: invoice ? { id: invoice.id, code: invoice.code, status: invoice.status, balanceCents: invoice.balanceCents } : null });
    }

    // ── REQUEST INFO — stay ON_HOLD, record the note for the customer ───────
    const note = (body.reason ?? "").trim();
    if (note.length < 5) {
      throw Errors.badRequest("Please describe the information you need from the customer (at least 5 characters).");
    }
    if (payment.status !== "ON_HOLD") {
      throw Errors.invalidTransition(`Information can only be requested for payments awaiting review (ON_HOLD) — this payment is ${payment.status}.`);
    }
    const updated = await db.payment.update({
      where: { id: payment.id },
      data: { reviewNote: note },
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "PAYMENT_REVIEW_REQUESTED",
      resourceType: "INVOICE", resourceId: invoice?.id ?? "",
      metadata: { paymentCode: payment.code, invoiceCode: invoice?.code ?? "", note },
    });
    await notifyCustomer(
      "More information needed for your payment",
      `Finance needs more information about your payment proof: ${note}`,
      "INFO",
    );
    await notifyRole("FINANCE", {
      title: `Info requested for proof ${payment.code}`,
      message: `${user.name} requested more information on proof ${payment.code} (invoice ${invoice?.code ?? "—"}). Payment stays on hold.`,
      type: "INFO",
      resourceType: "INVOICE",
      resourceId: invoice?.id ?? "",
    });

    return ok({ payment: updated });
  }, { permission: PERMISSIONS.payments_record })(req);
}
