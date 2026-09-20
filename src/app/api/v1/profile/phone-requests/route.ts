// MOHD.HMS ENTERPRISE — Secure phone-number change REQUEST workflow (spec §15/§16).
//
// Normal users (customers AND staff) cannot change their phone number directly —
// the field is managed by a SUPER_ADMIN (enforced in PATCH /api/v1/profile and
// PATCH /api/v1/users/{id}). Instead they submit a REQUEST that a SUPER_ADMIN
// reviews and applies. This resolves the onboarding contradiction without ever
// opening an uncontrolled user-side phone change:
//   Customer (mobile missing) → profile shows "Not yet registered"
//     → [Request Phone Number Update] → proposed number validated → request
//     → SUPER_ADMIN approves → canonical Customer.phone + display User.phone
//     updated together → profileComplete becomes true (phone + address rule
//     unchanged, assertCustomerProfileComplete untouched).
//
// POST   /api/v1/profile/phone-requests  (auth) — submit own request
// GET    /api/v1/profile/phone-requests  (auth) — own request history
// DELETE /api/v1/profile/phone-requests  (auth) — cancel own PENDING request
//
// The requester is ALWAYS the authenticated session user (IDOR-safe).

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { audit, notify } from "@/lib/hms/services";
import { clientIp } from "@/lib/hms/rate-limit";

/** Canonical mobile validation — same policy as the historical profile PATCH
 *  and the customer portal: Brunei-friendly, permissive on separators, 7–15
 *  digits. Never hardcodes an invalid fixed pattern beyond digit-count sanity. */
export function validateMobile(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Mobile number is required.";
  const digits = v.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return "Enter a valid mobile number (7–15 digits, e.g. +673 1234567).";
  }
  if (!/^\+?[\d\s().-]+$/.test(v)) {
    return "Enter a valid mobile number (digits with optional +, spaces, dashes).";
  }
  return null;
}

async function currentUserPhoneContext(userId: string) {
  const me = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, phone: true, role: true, customerId: true, customer: { select: { phone: true, code: true } } },
  });
  if (!me) throw Errors.notFound("User not found.");
  // Canonical current value: the Customer record for customers, the User
  // record for staff — exactly what the approval will write to.
  const current = me.role === "CUSTOMER" ? me.customer?.phone ?? "" : me.phone ?? "";
  return { me, current };
}

export const GET = handler(async ({ user }) => {
  const requests = await db.profileChangeRequest.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true, field: true, currentValue: true, proposedValue: true,
      status: true, decisionNote: true, decidedByName: true,
      decidedAt: true, createdAt: true,
    },
  });
  return ok(requests.map((r) => ({
    ...r,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  })));
});

const submitSchema = z.object({
  phone: z.string().max(40, "Mobile number must be 40 characters or fewer."),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, submitSchema);
  const proposed = body.phone.trim();

  const mobileError = validateMobile(proposed);
  if (mobileError) throw Errors.badRequest(mobileError, [{ path: "phone", message: mobileError }]);

  const { me, current } = await currentUserPhoneContext(user.id);

  if (current.trim() && current.trim() === proposed) {
    throw Errors.badRequest("This is already your registered mobile number.", [
      { path: "phone", message: "This is already your registered mobile number." },
    ]);
  }

  // One pending request per user — keeps the review queue honest.
  const existing = await db.profileChangeRequest.findFirst({
    where: { userId: user.id, field: "PHONE", status: "PENDING" },
    select: { id: true, proposedValue: true },
  });
  if (existing) {
    throw Errors.conflict("You already have a phone number update request pending review. Cancel it first if you want to submit a different number.");
  }

  const request = await db.profileChangeRequest.create({
    data: {
      userId: user.id,
      field: "PHONE",
      currentValue: current,
      proposedValue: proposed,
      status: "PENDING",
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "PHONE_CHANGE_REQUEST_SUBMITTED",
    resourceType: "ProfileChangeRequest",
    resourceId: request.id,
    metadata: { scope: "self", from: current, to: proposed, role: me.role },
    ip: clientIp(req),
  });

  // Notify the reviewers (SUPER_ADMINs review these requests, spec §16).
  const reviewers = await db.user.findMany({
    where: { role: "SUPER_ADMIN", status: "ACTIVE" },
    select: { id: true },
    take: 20,
  });
  await Promise.all(reviewers.map((r) =>
    notify({
      userId: r.id,
      title: "Phone number update request",
      message: `${me.name} (${me.email}) requested a mobile number update for review.`,
      type: "INFO",
      resourceType: "ProfileChangeRequest",
      resourceId: request.id,
    }).catch(() => undefined)
  ));

  return ok({
    id: request.id,
    status: request.status,
    proposedValue: request.proposedValue,
    currentValue: request.currentValue,
    createdAt: request.createdAt.toISOString(),
  });
});

export const DELETE = handler(async ({ req, user }) => {
  const pending = await db.profileChangeRequest.findFirst({
    where: { userId: user.id, field: "PHONE", status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) throw Errors.notFound("No pending phone number update request.");

  const updated = await db.profileChangeRequest.update({
    where: { id: pending.id },
    data: { status: "CANCELED" },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "PHONE_CHANGE_REQUEST_CANCELED",
    resourceType: "ProfileChangeRequest",
    resourceId: pending.id,
    metadata: { scope: "self", proposedValue: pending.proposedValue },
    ip: clientIp(req),
  });

  return ok({ id: updated.id, status: updated.status });
});
