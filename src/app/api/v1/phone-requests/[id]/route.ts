// MOHD.HMS ENTERPRISE — Phone-number change request decision (SUPER_ADMIN only).
//
// PATCH /api/v1/phone-requests/{id}  { action: "approve" | "reject", note? }
//
// Approve applies the change atomically and consistently (spec §30):
//   • Customer-linked requester → canonical Customer.phone AND display
//     User.phone are updated TOGETHER (User Management, customer portals and
//     documents all read the canonical Customer row; WhatsApp contact
//     identification resolves from the phone at inbound time, so no stale
//     mappings are left behind).
//   • Staff requester → User.phone updated.
// Every decision is audited and the requester is notified. Secrets/OTPs are
// never logged.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { audit, notify } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { clientIp } from "@/lib/hms/rate-limit";

const withId = (
  fn: (id: string, ctx: { req: NextRequest; user: { id: string; email: string; name: string; role: string } }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c))(req);
  };
};

const decideSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

export const PATCH = withId(async (id, { req, user }) => {
  if (user.role !== "SUPER_ADMIN") {
    throw Errors.forbidden("Only a SUPER_ADMIN can review phone number update requests.");
  }
  const body = await parseBody(req, decideSchema);
  const ip = clientIp(req);

  const request = await db.profileChangeRequest.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          id: true, email: true, name: true, phone: true, role: true, customerId: true,
          customer: { select: { id: true, code: true, phone: true } },
        },
      },
    },
  });
  if (!request) throw Errors.notFound("Phone number update request not found.");
  if (request.status !== "PENDING") {
    throw Errors.conflict(`This request was already ${request.status.toLowerCase()}.`);
  }

  const decision = {
    decidedById: user.id,
    decidedByName: user.name,
    decidedAt: new Date(),
    decisionNote: body.note?.trim() ?? "",
  };

  if (body.action === "reject") {
    await db.profileChangeRequest.update({
      where: { id },
      data: { status: "REJECTED", ...decision },
    });
    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "PHONE_CHANGE_REQUEST_REJECTED", resourceType: "ProfileChangeRequest", resourceId: id,
      metadata: { targetEmail: request.user.email, proposedValue: request.proposedValue, note: decision.decisionNote },
      ip,
    });
    await notify({
      userId: request.userId,
      title: "Phone number update rejected",
      message: decision.decisionNote
        ? `Your mobile number update request was not approved. Reason: ${decision.decisionNote}`
        : "Your mobile number update request was not approved. Contact your administrator for details.",
      type: "WARNING",
      resourceType: "ProfileChangeRequest",
      resourceId: id,
    });
    return ok({ id, status: "REJECTED" });
  }

  // ── Approve: apply the phone change atomically (§30 consistency) ──
  await db.$transaction(async (tx) => {
    await tx.profileChangeRequest.update({
      where: { id },
      data: { status: "APPROVED", ...decision },
    });
    if (request.user.customerId && request.user.customer) {
      await tx.customer.update({
        where: { id: request.user.customerId },
        data: { phone: request.proposedValue },
      });
    }
    await tx.user.update({
      where: { id: request.userId },
      data: { phone: request.proposedValue },
    });
  });

  await audit({
    actorId: user.id, actorEmail: user.email,
    action: "PHONE_CHANGE_REQUEST_APPROVED", resourceType: "ProfileChangeRequest", resourceId: id,
    metadata: {
      targetEmail: request.user.email,
      from: request.currentValue,
      to: request.proposedValue,
      customerCode: request.user.customer?.code ?? null,
    },
    ip,
  });

  await notify({
    userId: request.userId,
    title: "Phone number updated",
    message: "Your mobile number update request was approved and applied to your account.",
    type: "SUCCESS",
    resourceType: "ProfileChangeRequest",
    resourceId: id,
  });

  // Realtime (existing architecture): identity hints for authorized UIs.
  await emit({
    type: EVENT_TYPES.USER_UPDATED,
    resourceType: "USER",
    resourceId: request.userId,
    payload: { fields: ["phone"] },
    actorType: "USER",
    actorId: user.id,
  });

  return ok({ id, status: "APPROVED", phone: request.proposedValue });
});
