// MOHD.HMS ENTERPRISE — Shared payment settlement helper (spec §20-§30).
//
// ONE transactional implementation of "money actually moves" for BOTH payment
// paths so the ledger math can never drift between them:
//   • staff-recorded payments  (POST /api/v1/invoices/{id}/payments, status RECORDED)
//   • customer proof confirmed (POST /api/v1/payments/{id}/review, ON_HOLD → PAID)
//
// The helper MUST run inside a db.$transaction: invoice paid/balance/status
// update + ACC-BANK credit + INCOME ledger Transaction row land atomically
// (spec §42/§43 — exact integer cents, no floats).

import "server-only";
import type { Prisma } from "@prisma/client";

/** Same rich include the staff payments route has always returned. */
export const INVOICE_AFTER_PAYMENT_INCLUDE = {
  items: { orderBy: { id: "asc" } },
  payments: { orderBy: { paidAt: "desc" } },
  customer: { select: { id: true, code: true, companyName: true, contactPerson: true, email: true, phone: true, address: true, city: true } },
} satisfies Prisma.InvoiceInclude;

export type ApplyPaymentParams = {
  invoiceId: string;
  invoiceCode: string;
  /** Invoice state snapshot read BEFORE the write (inside the same tx). */
  totalCents: number;
  paidCentsBefore: number;
  statusBefore: string;
  amountCents: number;
  /** Payment row this settlement is booked against (ledger reference). */
  paymentId: string;
  paymentCode: string;
  paidAt: Date;
  actorId: string;
  /** Ledger transaction code from nextNumber("TRX") — generated OUTSIDE the tx. */
  trxCode: string;
  /**
   * Ledger description. Staff path keeps the legacy wording
   * `Payment {invoiceCode}`; confirmed proof payments use
   * `Payment {invoiceCode} (proof {paymentCode})`.
   */
  description?: string;
};

export type AppliedPayment = {
  invoice: Prisma.InvoiceGetPayload<{ include: typeof INVOICE_AFTER_PAYMENT_INCLUDE }>;
  /** False when no ACC-BANK account exists (best-effort credit skipped). */
  bankCredited: boolean;
};

/**
 * Apply a confirmed/recorded payment to its invoice inside the caller's
 * transaction: paidCents += amount, balanceCents = max(0, total − paid),
 * status PAID when fully settled / PARTIALLY_PAID when partially paid, then
 * credit the ACC-BANK account and book the INCOME ledger row.
 */
export async function applyPaymentToInvoice(
  tx: Prisma.TransactionClient,
  p: ApplyPaymentParams
): Promise<AppliedPayment> {
  const paidCents = p.paidCentsBefore + p.amountCents;
  const balanceCents = Math.max(0, p.totalCents - paidCents);
  const status = balanceCents === 0 ? "PAID" : paidCents > 0 ? "PARTIALLY_PAID" : p.statusBefore;

  const invoice = await tx.invoice.update({
    where: { id: p.invoiceId },
    data: { paidCents, balanceCents, status },
    include: INVOICE_AFTER_PAYMENT_INCLUDE,
  });

  // Credit the bank account + ledger entry (best-effort inside the same tx —
  // ACC-BANK may not exist in a fresh environment; the payment still settles).
  let bankCredited = false;
  const bank = await tx.account.findUnique({ where: { code: "ACC-BANK" } });
  if (bank) {
    await tx.account.update({ where: { id: bank.id }, data: { balanceCents: { increment: p.amountCents } } });
    await tx.transaction.create({
      data: {
        code: p.trxCode,
        type: "INCOME",
        category: "SERVICE_INCOME",
        description: p.description ?? `Payment ${p.invoiceCode}`,
        amountCents: p.amountCents,
        accountId: bank.id,
        date: p.paidAt,
        referenceType: "PAYMENT",
        referenceId: p.paymentId,
        createdById: p.actorId,
      },
    });
    bankCredited = true;
  }

  return { invoice, bankCredited };
}
