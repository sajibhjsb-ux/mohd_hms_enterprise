// MOHD.HMS ENTERPRISE — Profile API (own profile only, IDOR-safe).
// GET   /api/v1/profile  (auth)  — user + technicianProfile / employee / customer
//                                  context + derived profile completion state.
// PATCH /api/v1/profile  (auth)  — self-service profile update.
//   • Staff: name / phone on the User record (existing behaviour, unchanged).
//   • CUSTOMER: mobile number, address (multi-line), optional company name and
//     full name on the CANONICAL Customer record (what staff and documents
//     use), mirrored name on the login account. Email is the authentication
//     identity and is therefore read-only. Role, permissions, customer id,
//     status and ownership are never editable (schema picks allowed fields).
//
// The backend independently verifies profile completeness on every restricted
// job/service request (see assertCustomerProfileComplete) — frontend state is
// a UX hint only.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import { customerProfileState, missingCustomerFields } from "@/lib/hms/customer-profile";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    ""
  );
}

/** Canonical mobile validation: Brunei-friendly, permissive on separators.
 *  Accepts +673 XXXXXXX / 7–15 digits with spaces, dashes, dots, parentheses.
 *  Never hardcodes an invalid fixed pattern beyond digit-count sanity (§16). */
function validateMobile(raw: string): string | null {
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

export const GET = handler(async ({ user }) => {
  const me = await db.user.findUnique({
    where: { id: user.id },
    include: {
      technicianProfile: true,
      employee: { include: { department: true } },
      customer: true,
    },
  });
  if (!me) throw Errors.notFound("User not found.");

  const profileState = await customerProfileState(user);

  return ok({
    user: {
      id: me.id,
      email: me.email,
      name: me.name,
      phone: me.phone,
      role: me.role,
      status: me.status,
      avatarUrl: me.avatarUrl,
      googleLinked: !!me.googleId,
      lastLoginAt: me.lastLoginAt?.toISOString() ?? null,
      createdAt: me.createdAt.toISOString(),
    },
    technicianProfile: me.technicianProfile
      ? {
          id: me.technicianProfile.id,
          employeeNo: me.technicianProfile.employeeNo,
          skills: me.technicianProfile.skills,
          specialty: me.technicianProfile.specialty,
          status: me.technicianProfile.status,
          hourlyRateCents: me.technicianProfile.hourlyRateCents,
        }
      : null,
    employee: me.employee
      ? {
          id: me.employee.id,
          employeeNo: me.employee.employeeNo,
          name: `${me.employee.firstName} ${me.employee.lastName}`.trim(),
          position: me.employee.position,
          department: me.employee.department?.name ?? null,
          email: me.employee.email,
          phone: me.employee.phone,
          joinDate: me.employee.joinDate?.toISOString() ?? null,
          status: me.employee.status,
        }
      : null,
    customer: me.customer
      ? {
          id: me.customer.id,
          code: me.customer.code,
          companyName: me.customer.companyName,
          contactPerson: me.customer.contactPerson,
          email: me.customer.email,
          phone: me.customer.phone,
          address: me.customer.address,
          city: me.customer.city,
          country: me.customer.country,
          status: me.customer.status,
        }
      : null,
    // Machine-readable profile state (spec §38) — authoritative, derived live.
    profileComplete: profileState.profileComplete,
    missingFields: profileState.missingFields,
    onboardingRequired: user.role === "CUSTOMER" && !profileState.profileComplete,
  });
});

const patchSchema = z
  .object({
    // Staff (and the shared display name for customers):
    name: z.string().trim().min(2, "Name must be at least 2 characters.").max(80).optional(),
    // Staff path (User.phone):
    phone: z.string().trim().max(30).optional(),
    // Customer self-service path (canonical Customer record):
    mobile: z.string().max(40).optional(),
    address: z.string().max(500, "Address must be 500 characters or fewer.").optional(),
    companyName: z.string().max(200, "Company name must be 200 characters or fewer.").optional(),
    city: z.string().max(120).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "Nothing to update."
  );

export const PATCH = handler(async ({ req, user }) => {
  const body = await parseBody(req, patchSchema);
  const isCustomer = user.role === "CUSTOMER";

  if (isCustomer) {
    // ── Customer self-service ──
    // The record written is ALWAYS the one linked to the session user —
    // never an id from the browser (IDOR-safe, spec §28).
    const me = await db.user.findUnique({
      where: { id: user.id },
      include: { customer: true },
    });
    if (!me) throw Errors.notFound("User not found.");
    if (!me.customer) throw Errors.conflict("Your account is not linked to a customer record. Contact support.");

    // Mobile: required to be present-but-valid when provided; blank is
    // rejected (mobile + address are the required fields).
    let mobile: string | undefined;
    if (body.mobile !== undefined) {
      const mobileError = validateMobile(body.mobile);
      if (mobileError) throw Errors.badRequest(mobileError, [{ path: "mobile", message: mobileError }]);
      mobile = body.mobile.trim();
    }

    // Address: multi-line preserved verbatim (only the ends are trimmed) —
    // never collapsed, never truncated (spec §17).
    const address = body.address !== undefined ? body.address.replace(/^\s+|\s+$/g, "") : undefined;
    // Company name: optional; empty string explicitly clears it (spec §5/§27).
    const companyName = body.companyName !== undefined ? body.companyName.trim() : undefined;
    const city = body.city !== undefined ? body.city.trim() : undefined;

    const name = body.name !== undefined ? body.name : undefined;

    const updated = await db.$transaction(async (tx) => {
      const customer = await tx.customer.update({
        where: { id: me.customer!.id },
        data: {
          ...(mobile !== undefined ? { phone: mobile } : {}),
          ...(address !== undefined ? { address } : {}),
          ...(companyName !== undefined ? { companyName } : {}),
          ...(city !== undefined ? { city } : {}),
          ...(name !== undefined ? { contactPerson: name } : {}),
        },
      });
      // Keep the login display name in sync when explicitly provided.
      if (name !== undefined) {
        await tx.user.update({ where: { id: user.id }, data: { name } });
      }
      return customer;
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PROFILE_UPDATED",
      resourceType: "CUSTOMER",
      resourceId: updated.id,
      metadata: {
        scope: "customer",
        fields: Object.keys(body),
        customerCode: updated.code,
      },
      ip: clientIp(req),
    });

    const state = missingCustomerFields(updated);
    return ok({
      id: updated.id,
      code: updated.code,
      companyName: updated.companyName,
      contactPerson: updated.contactPerson,
      email: updated.email,
      phone: updated.phone,
      address: updated.address,
      city: updated.city,
      name: name ?? me.name,
      profileComplete: state.length === 0,
      missingFields: state,
    });
  }

  // ── Staff self-service (unchanged existing behaviour) ──
  if (body.mobile !== undefined || body.address !== undefined || body.companyName !== undefined || body.city !== undefined) {
    throw Errors.badRequest("Only name and phone can be updated on this account.");
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone === "" ? null : body.phone } : {}),
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "PROFILE_UPDATED",
    resourceType: "User",
    resourceId: user.id,
    metadata: { scope: "user", fields: Object.keys(body) },
    ip: clientIp(req),
  });

  return ok({
    id: updated.id,
    email: updated.email,
    name: updated.name,
    phone: updated.phone,
    role: updated.role,
  });
});
