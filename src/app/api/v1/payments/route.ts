// MOHD.HMS ENTERPRISE — Payment review queue (spec §22/§27).
//
//   GET /api/v1/payments?status=ON_HOLD|REJECTED|PAID|RECORDED|ALL&page=&pageSize=
//
// Finance list of customer-submitted payment proofs. Defaults to the ON_HOLD
// review queue. payments_read is REQUIRED (CUSTOMER lacks it → 403), so this
// endpoint is staff-only by construction; FINANCE/ADMIN see everything.

import { db } from "@/lib/db";
import { handler, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { Prisma } from "@prisma/client";

export const GET = handler(async ({ req }) => {
  const { page, pageSize, skip, take, status } = listQuery(req);

  // §27 — the review queue defaults to payments awaiting confirmation;
  // `status=ALL` disables the filter (history views pass an explicit status).
  const normalized = (status || "ON_HOLD").toUpperCase();
  const where: Prisma.PaymentWhereInput = normalized === "ALL" ? {} : { status: normalized };

  const [total, rows] = await Promise.all([
    db.payment.count({ where }),
    db.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        id: true, code: true, amountCents: true, method: true, status: true,
        bank: true, reference: true, paidAt: true, createdAt: true,
        proofName: true, proofSizeBytes: true, proofMimeType: true,
        verification: true, reviewNote: true, reviewedAt: true, note: true,
        submittedById: true,
        invoice: {
          select: {
            id: true, code: true, totalCents: true, balanceCents: true, status: true,
            customer: { select: { id: true, code: true, companyName: true, contactPerson: true } },
          },
        },
      },
    }),
  ]);

  // Payment has no submittedById relation — resolve submitter names in one query.
  const submitterIds = [...new Set(rows.map((r) => r.submittedById).filter((v): v is string => !!v))];
  const submitters = submitterIds.length
    ? await db.user.findMany({ where: { id: { in: submitterIds } }, select: { id: true, name: true, email: true } })
    : [];
  const byId = new Map(submitters.map((u) => [u.id, u]));

  const items = rows.map((r) => ({
    id: r.id,
    code: r.code,
    amountCents: r.amountCents,
    method: r.method,
    status: r.status,
    bank: r.bank,
    reference: r.reference,
    note: r.note,
    paidAt: r.paidAt,
    createdAt: r.createdAt,
    proofName: r.proofName,
    proofSizeBytes: r.proofSizeBytes,
    proofMimeType: r.proofMimeType,
    verification: r.verification,
    reviewNote: r.reviewNote,
    reviewedAt: r.reviewedAt,
    submittedBy: r.submittedById ? byId.get(r.submittedById) ?? null : null,
    invoice: r.invoice,
  }));

  return okList(items, pagedMeta(page, pageSize, total));
}, { permission: PERMISSIONS.payments_read });
