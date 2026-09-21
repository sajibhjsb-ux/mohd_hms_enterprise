// MOHD.HMS ENTERPRISE — Authorized payment-proof download (spec §23/§42).
//
//   GET /api/v1/payments/{id}/proof
//
// Streams the customer's uploaded proof out of the private bucket. Access is
// object-level authorized (never a public URL):
//   • the submitter themself,
//   • a portal user of the same customer,
//   • staff holding payments_record (FINANCE / ADMIN / SUPER_ADMIN).
// Everyone else gets 403; missing proof ⇒ 404.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const payment = await db.payment.findUnique({
      where: { id },
      select: { id: true, code: true, customerId: true, submittedById: true, proofObjectKey: true, proofName: true, proofMimeType: true },
    });
    if (!payment) throw Errors.notFound("Payment not found.");

    const isSubmitter = !!payment.submittedById && payment.submittedById === user.id;
    const isSameCustomer = !!user.customerId && !!payment.customerId && user.customerId === payment.customerId;
    const isFinanceStaff = roleCan(user.role, PERMISSIONS.payments_record);
    if (!isSubmitter && !isSameCustomer && !isFinanceStaff) throw Errors.forbidden();

    if (!payment.proofObjectKey) throw Errors.notFound("No payment proof was uploaded for this payment.");
    const obj = await storage.get(payment.proofObjectKey);
    if (!obj) throw Errors.notFound("The proof file could not be found in storage.");

    await audit({
      actorId: user.id, actorEmail: user.email, action: "PAYMENT_PROOF_DOWNLOADED",
      resourceType: "PAYMENT", resourceId: payment.id,
      metadata: { paymentCode: payment.code },
    });

    const filename = (payment.proofName || `proof-${payment.code}`).replace(/["\r\n]/g, "");
    return new NextResponse(new Uint8Array(obj.buffer), {
      status: 200,
      headers: {
        "Content-Type": payment.proofMimeType || obj.contentType || "application/octet-stream",
        "Content-Length": String(obj.buffer.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  })(req);
}
