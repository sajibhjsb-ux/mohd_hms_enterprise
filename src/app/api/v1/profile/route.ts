// MOHD.HMS ENTERPRISE — Profile API (own profile only, IDOR-safe).
// GET   /api/v1/profile  (auth)  — user + technicianProfile / employee / customer
//                                  context + derived profile completion state +
//                                  pending phone-change request (if any).
// PATCH /api/v1/profile  (auth)  — self-service profile update with BACKEND
//                                  field-level authorization (spec §6/§7):
//   • IDENTITY FIELDS (name, email, phone/mobile, role, status, ids) are
//     immutable for EVERY caller on this endpoint. A normal user submitting
//     them receives an explicit 403 — never a silent strip. Only a
//     SUPER_ADMIN can change name/email/phone, exclusively through the
//     User Management API (PATCH /api/v1/users/{id}) where dependency
//     handling (Google linkage, canonical mirrors, audit) lives.
//   • CUSTOMER: address (multi-line, verbatim), optional company name and
//     city on the CANONICAL Customer record (what staff and documents use).
//     Mobile number is NOT directly editable — customers submit a phone
//     change request (see /api/v1/profile/phone-requests) for SUPER_ADMIN
//     approval. Email is the authentication identity and stays read-only.
//   • STAFF: no self-service body fields on the User record — identity and
//     contact fields are managed by administrators; the profile photo is a
//     separate upload endpoint (POST /api/v1/profile/avatar).
//
// The backend independently verifies profile completeness on every restricted
// job/service request (see assertCustomerProfileComplete) — frontend state is
// a UX hint only.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import { customerProfileState, missingCustomerFields } from "@/lib/hms/customer-profile";
import { isAvatarRef } from "@/lib/hms/profile-photo";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    ""
  );
}

const IDENTITY_FIELD_LABELS: Record<string, string> = {
  name: "full name",
  email: "email address",
  phone: "phone number",
  mobile: "mobile number",
  role: "role",
  status: "account status",
  userId: "user id",
  customerId: "customer id",
  employeeId: "employee id",
};

/** Identity/managed fields a normal user may never submit (spec §4/§6/§7/§19). */
const FORBIDDEN_PROFILE_FIELDS = Object.keys(IDENTITY_FIELD_LABELS);

export const GET = handler(async ({ user }) => {
  const me = await db.user.findUnique({
    where: { id: user.id },
    include: {
      technicianProfile: true,
      employee: { include: { department: true } },
      customer: true,
      // Job position (job title) — independent of the RBAC role above.
      position: true,
    },
  });
  if (!me) throw Errors.notFound("User not found.");

  const [profileState, pendingPhoneRequest, corporateMailbox] = await Promise.all([
    customerProfileState(user),
    db.profileChangeRequest.findFirst({
      where: { userId: user.id, field: "PHONE", status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, proposedValue: true, currentValue: true, createdAt: true,
      },
    }),
    // Corporate mailbox (email provisioning spec §8) — the employee profile
    // shows the PERSONAL/ACCOUNT email above and the CORPORATE email here.
    db.mailbox.findFirst({
      where: { kind: "PERSONAL", ownerUserId: user.id },
      select: { email: true, isActive: true },
    }),
  ]);

  return ok({
    user: {
      id: me.id,
      email: me.email,
      name: me.name,
      phone: me.phone,
      role: me.role,
      // Organizational job title — display-only, never an authorization input.
      position: me.position?.name ?? null,
      status: me.status,
      avatarUrl: isAvatarRef(me.avatarUrl) ? me.avatarUrl : null,
      googleLinked: !!me.googleId,
      lastLoginAt: me.lastLoginAt?.toISOString() ?? null,
      createdAt: me.createdAt.toISOString(),
    },
    // Corporate email (email provisioning spec §8) — null when the account has
    // no corporate mailbox (e.g. CUSTOMER accounts). Disabled mailboxes are
    // shown with active:false so the profile is honest about mailbox state.
    corporateEmail: corporateMailbox
      ? { email: corporateMailbox.email, active: corporateMailbox.isActive }
      : null,
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
    // Secure phone-change workflow state (spec §15/§16) — surfaced so the UI can
    // show "Request pending" instead of pretending the field is editable.
    pendingPhoneRequest: pendingPhoneRequest
      ? {
          id: pendingPhoneRequest.id,
          proposedValue: pendingPhoneRequest.proposedValue,
          currentValue: pendingPhoneRequest.currentValue,
          createdAt: pendingPhoneRequest.createdAt.toISOString(),
        }
      : null,
  });
});

const patchSchema = z
  .object({
    // Customer self-service path (canonical Customer record). Mobile is
    // deliberately ABSENT — it is a managed field (see header comment).
    address: z.string().max(500, "Address must be 500 characters or fewer.").optional(),
    companyName: z.string().max(200, "Company name must be 200 characters or fewer.").optional(),
    city: z.string().max(120).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "Nothing to update."
  );

export const PATCH = handler(async ({ req, user }) => {
  // ── Field-level authorization BEFORE schema parsing (spec §6 — reject, never
  // silently strip). The body is read ONCE and inspected for managed/identity
  // fields; any occurrence from any caller is rejected on this endpoint:
  // identity changes go through User Management (SUPER_ADMIN only), which
  // applies the canonical mirrors, Google-linkage handling and audit entries.
  let raw: Record<string, unknown> = {};
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch {
    throw Errors.badRequest("Request body must be valid JSON.");
  }
  const attempted = Object.keys(raw).filter((k) => FORBIDDEN_PROFILE_FIELDS.includes(k));
  if (attempted.length > 0) {
    const fields = attempted.map((k) => IDENTITY_FIELD_LABELS[k] ?? k).join(", ");
    throw Errors.forbidden(
      `Your ${fields} can only be changed by a SUPER_ADMIN. Please contact your administrator or submit a phone number update request.`,
    );
  }

  const body = patchSchema.parse(raw);

  if (user.role === "CUSTOMER") {
    // ── Customer self-service ──
    // The record written is ALWAYS the one linked to the session user —
    // never an id from the browser (IDOR-safe, spec §28).
    const me = await db.user.findUnique({
      where: { id: user.id },
      include: { customer: true },
    });
    if (!me) throw Errors.notFound("User not found.");
    if (!me.customer) throw Errors.conflict("Your account is not linked to a customer record. Contact support.");

    // Address: multi-line preserved verbatim (only the ends are trimmed) —
    // never collapsed, never truncated (spec §13).
    const address = body.address !== undefined ? body.address.replace(/^\s+|\s+$/g, "") : undefined;
    // Company name: optional; empty string explicitly clears it (spec §14).
    const companyName = body.companyName !== undefined ? body.companyName.trim() : undefined;
    const city = body.city !== undefined ? body.city.trim() : undefined;

    const updated = await db.customer.update({
      where: { id: me.customer.id },
      data: {
        ...(address !== undefined ? { address } : {}),
        ...(companyName !== undefined ? { companyName } : {}),
        ...(city !== undefined ? { city } : {}),
      },
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
      profileComplete: state.length === 0,
      missingFields: state,
    });
  }

  // ── Staff accounts ──
  // Every remaining body field is customer-scoped; staff have no self-service
  // body fields (identity/contact fields are managed; the photo has its own
  // endpoint). Respond honestly instead of pretending something was saved.
  throw Errors.badRequest("There are no self-service profile fields for your account type. Contact your administrator to update your details.");
});
