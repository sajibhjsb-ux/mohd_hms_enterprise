// MOHD.HMS ENTERPRISE — Phone-number change request REVIEW queue (SUPER_ADMIN).
//
// GET /api/v1/phone-requests?status=PENDING  — review queue (requester context).
// Only SUPER_ADMIN (spec §5/§16: only a SUPER_ADMIN may change a user's phone).
// The approval action itself lives in /[id]/route.ts.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";

export const GET = handler(async ({ req, user }) => {
  if (user.role !== "SUPER_ADMIN") {
    throw Errors.forbidden("Only a SUPER_ADMIN can review phone number update requests.");
  }
  const statusParam = new URL(req.url).searchParams.get("status");
  const status = statusParam && ["PENDING", "APPROVED", "REJECTED", "CANCELED"].includes(statusParam)
    ? statusParam
    : "PENDING";

  const requests = await db.profileChangeRequest.findMany({
    where: { field: "PHONE", status },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      user: {
        select: {
          id: true, name: true, email: true, role: true, phone: true,
          customer: { select: { id: true, code: true, companyName: true, contactPerson: true, phone: true } },
        },
      },
    },
  });

  return ok(requests.map((r) => ({
    id: r.id,
    field: r.field,
    currentValue: r.currentValue,
    proposedValue: r.proposedValue,
    status: r.status,
    decisionNote: r.decisionNote,
    decidedByName: r.decidedByName,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    requester: {
      id: r.user.id,
      name: r.user.name,
      email: r.user.email,
      role: r.user.role,
      phone: r.user.phone,
      customer: r.user.customer
        ? {
            id: r.user.customer.id,
            code: r.user.customer.code,
            companyName: r.user.customer.companyName,
            contactPerson: r.user.customer.contactPerson,
            phone: r.user.customer.phone,
          }
        : null,
    },
  })));
});
