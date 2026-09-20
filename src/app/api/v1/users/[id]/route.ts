// MOHD.HMS ENTERPRISE — Users module API (detail / update / delete).
// Guards: cannot change own role, cannot disable self, non-SUPER_ADMIN cannot
// touch SUPER_ADMIN accounts. Password resets revoke all sessions.
// IDENTITY FIELDS (spec §5): name / email / phone can ONLY be changed by a
// SUPER_ADMIN — enforced here on the backend, never just in the UI. Admin
// accounts keep the existing role/status/password administration powers.
// Email changes are handled with their dependency chain (spec §29): unique
// check, Google linkage preserved (sign-in resolves by googleId first),
// verification reset, canonical mirrors (Customer/Employee) and audit.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { hashPassword, validatePasswordStrength } from "@/lib/hms/auth";
import { audit, notify, nextNumber } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { clientIp } from "@/lib/hms/rate-limit";

/**
 * Next.js 16 App Router: dynamic route params arrive as a Promise in the 2nd
 * handler argument. Bridge: resolve params, then delegate to handler() so
 * auth/RBAC/centralized error handling still applies.
 */
const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

function assertNotSuperAdminTarget(target: { role: string }, actor: SessionUser) {
  if (target.role === "SUPER_ADMIN" && actor.role !== "SUPER_ADMIN") {
    throw Errors.forbidden("Only a SUPER_ADMIN can modify another SUPER_ADMIN account.");
  }
}

/**
 * Role-assignment escalation guard (role/position spec §25): granting the
 * SUPER_ADMIN role itself is a SUPER_ADMIN-only act. The edit UI hides the
 * option for non-SA actors — this makes that rule backend-enforced, not just
 * a disabled dropdown.
 */
function assertCanAssignRole(newRole: string | undefined, actor: SessionUser) {
  if (newRole === "SUPER_ADMIN" && actor.role !== "SUPER_ADMIN") {
    throw Errors.forbidden("Only a SUPER_ADMIN can grant the SUPER_ADMIN role.");
  }
}

export const GET = withId(PERMISSIONS.users_read, async (id) => {
  const u = await db.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, name: true, phone: true, role: true, status: true,
      lastLoginAt: true, createdAt: true, customerId: true,
      customer: { select: { id: true, companyName: true, code: true } },
      technicianProfile: { select: { id: true, employeeNo: true, specialty: true, skills: true, status: true } },
      employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } },
      // Job position (organizational title) — displayed SEPARATELY from role.
      positionId: true,
      position: { select: { id: true, name: true, status: true } },
    },
  });
  if (!u) throw Errors.notFound("User not found.");
  return ok(u);
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).nullable().optional(),
  // SUPER_ADMIN-only identity field (spec §5/§17/§29).
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(200).optional(),
  role: z.enum(["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "CUSTOMER", "FINANCE", "HR"]).optional(),
  // JOB POSITION (job title) — independent from role (spec §1/§13/§22). May be
  // sent alone, with role, or cleared with null. NEVER affects permissions.
  positionId: z.string().min(1).nullable().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  action: z.literal("reset_password").optional(),
  newPassword: z.string().max(200).optional(),
});

export const PATCH = withId(PERMISSIONS.users_update, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const ip = clientIp(req);

  const target = await db.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, name: true, phone: true, role: true, status: true, googleId: true,
      positionId: true,
      position: { select: { id: true, name: true } },
      technicianProfile: { select: { id: true } },
      employee: { select: { id: true, position: true } },
    },
  });
  if (!target) throw Errors.notFound("User not found.");

  assertNotSuperAdminTarget(target, user);
  // §25 escalation guard: only a SUPER_ADMIN may grant the SUPER_ADMIN role.
  assertCanAssignRole(body.role, user);

  // ── Identity-field gate (spec §5) — BACKEND enforcement, not UI-only ──
  // Only a SUPER_ADMIN may change a user's name, email or phone. This
  // includes ADMIN accounts (they keep role/status/password administration).
  const identityChange = body.name !== undefined || body.phone !== undefined || body.email !== undefined;
  if (identityChange && user.role !== "SUPER_ADMIN") {
    throw Errors.forbidden("Only a SUPER_ADMIN can change a user's name, email or phone number.");
  }

  // ── Password reset action ──
  if (body.action === "reset_password") {
    if (!body.newPassword) throw Errors.badRequest("New password is required.", [{ path: "newPassword", message: "New password is required." }]);
    const strengthError = validatePasswordStrength(body.newPassword);
    if (strengthError) throw Errors.badRequest(strengthError, [{ path: "newPassword", message: strengthError }]);

    const passwordHash = await hashPassword(body.newPassword);
    await db.$transaction([
      db.user.update({ where: { id }, data: { passwordHash } }),
      db.session.deleteMany({ where: { userId: id } }), // force re-login everywhere
    ]);

    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "USER_PASSWORD_RESET", resourceType: "USER", resourceId: id,
      metadata: { email: target.email }, ip,
    });
    await notify({
      userId: id,
      title: "Password reset by administrator",
      message: "Your password was reset by an administrator. Please sign in with your new password.",
      type: "WARNING",
      resourceType: "USER", resourceId: id,
    });

    return ok({ id, passwordReset: true });
  }

  // ── Regular profile/role/status update ──
  if (body.role && body.role !== target.role && id === user.id) {
    throw Errors.badRequest("You cannot change your own role.");
  }
  if (body.status === "DISABLED" && id === user.id) {
    throw Errors.badRequest("You cannot disable your own account.");
  }

  // ── Last active SUPER_ADMIN protection (role-change spec §6) ──
  // The system must never end up with zero active SUPER_ADMIN accounts. A
  // demotion of an ACTIVE SUPER_ADMIN is only allowed while another ACTIVE
  // SUPER_ADMIN remains. (Self-demotion is already blocked above; this guard
  // covers the demotion of OTHER super admins, including concurrent ones.)
  const demotingSuperAdmin =
    target.role === "SUPER_ADMIN" &&
    target.status === "ACTIVE" &&
    body.role !== undefined &&
    body.role !== "SUPER_ADMIN";
  if (demotingSuperAdmin) {
    const otherActiveSuperAdmins = await db.user.count({
      where: { role: "SUPER_ADMIN", status: "ACTIVE", id: { not: id } },
    });
    if (otherActiveSuperAdmins === 0) {
      throw Errors.conflict("Cannot change the role of the last active SUPER_ADMIN account. Promote another SUPER_ADMIN first.");
    }
  }

  // ── Job-position validation (spec §29) ──
  // The position must exist and be ACTIVE to be assigned (a deactivated title
  // stays on people who already hold it — clearing or reassignment is how
  // they move off it). Position changes are independent of role changes.
  const positionChanged = body.positionId !== undefined && body.positionId !== target.positionId;
  let newPositionName: string | null = null;
  if (body.positionId !== undefined && body.positionId !== null) {
    const pos = await db.jobPosition.findUnique({ where: { id: body.positionId }, select: { id: true, name: true, status: true } });
    if (!pos) throw Errors.badRequest("Selected position does not exist.", [{ path: "positionId", message: "Unknown position." }]);
    if (pos.status !== "ACTIVE" && pos.id !== target.positionId) {
      throw Errors.badRequest("This position is inactive and cannot be assigned.", [{ path: "positionId", message: "Position is inactive." }]);
    }
    newPositionName = pos.name;
  }

  // Pre-allocate a technician number OUTSIDE the transaction — nextNumber()
  // writes via the global db client, which would deadlock on SQLite inside one.
  const tecEmployeeNo = body.role === "TECHNICIAN" && !target.technicianProfile ? await nextNumber("TEC") : null;

  // ── Email change dependency chain (spec §29) ──
  // Email is the login identity. Changing it must not silently break sign-in,
  // verification state or mirrored records:
  //   • unique (except the target itself),
  //   • Google linkage PRESERVED — sign-in resolves by googleId first, so
  //     OAuth keeps working; the stored googleId is never touched here,
  //   • verification reset (a new address is an unverified address),
  //   • canonical mirrors updated in the same transaction (Customer/Employee),
  //   • dedicated audit entry with from→to (never a bare field flip).
  let emailChanged = false;
  if (body.email !== undefined && body.email !== target.email) {
    const emailTaken = await db.user.findUnique({ where: { email: body.email }, select: { id: true } });
    if (emailTaken && emailTaken.id !== id) {
      throw Errors.conflict("A user with this email address already exists.");
    }
    emailChanged = true;
  }

  // Canonical customer mirror (name/phone/email on the Customer record is what
  // staff tools and documents read — spec §43 consistency).
  const customerMirror =
    body.name !== undefined || body.phone !== undefined || body.email !== undefined;

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.phone !== undefined ? { phone: body.phone?.trim() || null } : {}),
        ...(body.email !== undefined ? { email: body.email, emailVerified: null } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.positionId !== undefined ? { positionId: body.positionId } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      select: {
        id: true, email: true, name: true, phone: true, role: true, status: true,
        lastLoginAt: true, createdAt: true, customerId: true,
        customer: { select: { id: true, companyName: true, code: true } },
        technicianProfile: { select: { id: true, employeeNo: true, specialty: true, status: true } },
      },
    });

    // Keep the canonical customer identity consistent with the login account.
    if (u.customerId && customerMirror) {
      await tx.customer.update({
        where: { id: u.customerId },
        data: {
          ...(body.name !== undefined ? { contactPerson: body.name.trim() } : {}),
          ...(body.phone !== undefined ? { phone: body.phone?.trim() || "" } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
        },
      });
    }

    // Employee contact mirror (HR/employee records read their own email).
    if (body.email !== undefined) {
      await tx.employee.updateMany({ where: { userId: id }, data: { email: body.email } });
    }

    // Job-position mirror (role/position spec — one person, ONE job title):
    // the linked Employee record follows the account's position, its free-text
    // `position` string stays the denormalized snapshot used by letters,
    // attendance and the profile page. Clearing the account position clears
    // the linked employee's catalog link and snapshot together.
    if (positionChanged) {
      await tx.employee.updateMany({
        where: { userId: id },
        data: { positionId: body.positionId ?? null, position: newPositionName ?? "" },
      });
    }

    // Becoming a technician: provision a profile if missing (role-change spec
    // §11/§12 — one canonical user↔technician identity, TEC number reused on
    // re-promotion). A previously-retired profile is REACTIVATED, never
    // duplicated. Leaving the technician role: the profile is RETIRED — hidden
    // from the roster and all assignment dropdowns (spec §13) while every
    // historical work order / complaint / PM task keeps its link intact.
    if (u.role === "TECHNICIAN") {
      if (!u.technicianProfile && tecEmployeeNo) {
        await tx.technicianProfile.create({
          data: { userId: id, employeeNo: tecEmployeeNo, specialty: "GENERAL", status: "AVAILABLE" },
        });
      } else if (u.technicianProfile && u.technicianProfile.status === "RETIRED") {
        await tx.technicianProfile.update({
          where: { id: u.technicianProfile.id },
          data: { status: "AVAILABLE" },
        });
      }
    } else if (body.role !== undefined && u.technicianProfile && u.technicianProfile.status !== "RETIRED") {
      await tx.technicianProfile.update({
        where: { id: u.technicianProfile.id },
        data: { status: "RETIRED" },
      });
    }
    return u;
  });

  // Re-fetch so a freshly provisioned technician profile is included.
  const fresh = await db.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, name: true, phone: true, role: true, status: true,
      lastLoginAt: true, createdAt: true,
      customer: { select: { id: true, companyName: true, code: true } },
      technicianProfile: { select: { id: true, employeeNo: true, specialty: true, status: true } },
      positionId: true,
      position: { select: { id: true, name: true } },
    },
  });

  // Disabling a user kills their active sessions immediately.
  if (body.status === "DISABLED") {
    await db.session.deleteMany({ where: { userId: id } });
  }

  // Did the role actually change? (used by both audit records below)
  const roleChanged = body.role !== undefined && body.role !== target.role;

  await audit({
    actorId: user.id, actorEmail: user.email,
    action: "USER_UPDATED", resourceType: "USER", resourceId: id,
    // When the role changed, the dedicated USER_ROLE_CHANGED row (below) owns
    // the from→to record — keeping it here too would double-list the change in
    // the role history. Legacy rows (before the dedicated action) still carry
    // roleFrom/roleTo and remain readable by the history view.
    metadata: { email: body.email ?? target.email, fields: Object.keys(body).filter((k) => k !== "action"), ...(roleChanged ? {} : { roleFrom: target.role, roleTo: body.role ?? target.role }) },
    ip,
  });

  // ── Dedicated role-change audit record (role-change spec §17/§18) ──
  // A clear ROLE CHANGE row (previous → new, SUCCESS) that the user-detail
  // role history reads; from→to keeps each change reviewable in the audit UI.
  // Position context is included so a combined role+position change (spec §14)
  // is reviewable from either dedicated row.
  if (roleChanged) {
    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "USER_ROLE_CHANGED", resourceType: "USER", resourceId: id,
      metadata: {
        targetEmail: target.email, targetName: target.name,
        previousRole: target.role, newRole: body.role, result: "SUCCESS",
        // Position context at change time — role change NEVER moves the
        // position (spec §12); this only documents what it was.
        positionAtChange: target.position?.name ?? null,
        ...(positionChanged ? { previousPosition: target.position?.name ?? null, newPosition: newPositionName } : {}),
      },
      ip,
    });
    await notify({
      userId: id,
      title: "Your account role was changed",
      message: `Your role was changed from ${target.role} to ${body.role} by ${user.name}. You may need to refresh to see your new access.`,
      type: "INFO", resourceType: "USER", resourceId: id,
    });
  }

  // ── Dedicated position-change audit record (role/position spec §15) ──
  // Previous → new JOB TITLE, changed-by, result — the position history view
  // reads these rows. Position changes never alter permissions (spec §22), so
  // sessions are untouched; the USER_UPDATED realtime event lets the target's
  // open app refresh its display.
  if (positionChanged) {
    const previousPositionName = target.position?.name ?? null;
    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "USER_POSITION_CHANGED", resourceType: "USER", resourceId: id,
      metadata: {
        targetEmail: target.email, targetName: target.name,
        previousPosition: previousPositionName, newPosition: newPositionName,
        // Role context at change time — position change NEVER moves the role.
        roleAtChange: body.role ?? target.role,
        result: "SUCCESS",
      },
      ip,
    });
    await notify({
      userId: id,
      title: "Your position has been updated",
      message: newPositionName
        ? `Your position has been updated to ${newPositionName} by ${user.name}.`
        : `Your position (${previousPositionName ?? "—"}) has been cleared by ${user.name}.`,
      type: "INFO", resourceType: "USER", resourceId: id,
    });
  }

  // Dedicated identity-change audit entries (spec §27) — values are contact
  // data, not secrets; from→to makes each change reviewable.
  if (body.name !== undefined && body.name.trim() !== target.name) {
    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "ADMIN_NAME_CHANGED", resourceType: "USER", resourceId: id,
      metadata: { targetEmail: body.email ?? target.email, from: target.name, to: body.name.trim() },
      ip,
    });
  }
  if (body.phone !== undefined && (body.phone?.trim() || null) !== target.phone) {
    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "ADMIN_PHONE_CHANGED", resourceType: "USER", resourceId: id,
      metadata: { targetEmail: body.email ?? target.email, from: target.phone ?? "", to: body.phone?.trim() || "" },
      ip,
    });
  }
  if (emailChanged) {
    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "ADMIN_EMAIL_CHANGED", resourceType: "USER", resourceId: id,
      metadata: { from: target.email, to: body.email, googleLinked: !!target.googleId },
      ip,
    });
    await notify({
      userId: id,
      title: "Email address changed",
      message: `Your sign-in email was changed by an administrator to ${body.email}. Use the new address the next time you sign in.`,
      type: "WARNING", resourceType: "USER", resourceId: id,
    });
  }

  if (body.status === "DISABLED") {
    await notify({
      userId: id,
      title: "Account disabled",
      message: "Your account has been disabled by an administrator.",
      type: "WARNING", resourceType: "USER", resourceId: id,
    });
  }

  // Realtime (STEP 11/18): role/status changes propagate (navigation/access hints).
  // SESSION NOTE (role-change spec §8/§9): authorization is resolved LIVE from
  // the User row on every request (getSessionUser → session.user.role) — there
  // are no JWT role claims and no Redis permission cache, so the new role is
  // authoritative on the user's very next API call. Sessions are intentionally
  // KEPT (no forced re-login); the client refreshes its own session state when
  // the USER_UPDATED event for its own id arrives (shell.tsx sync).
  await emit({ type: EVENT_TYPES.USER_UPDATED, resourceType: "USER", resourceId: id, payload: { fields: Object.keys(body).filter((k) => k !== "action"), roleChanged, positionChanged }, actorType: "USER", actorId: user.id });
  return ok(fresh ?? updated);
});

export const DELETE = withId(PERMISSIONS.users_delete, async (id, { req, user }) => {
  const ip = clientIp(req);

  if (id === user.id) throw Errors.badRequest("You cannot delete your own account.");

  const target = await db.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, role: true, status: true } });
  if (!target) throw Errors.notFound("User not found.");

  assertNotSuperAdminTarget(target, user);

  // Soft-disable + revoke sessions (never hard delete — audit/history integrity).
  await db.$transaction([
    db.user.update({ where: { id }, data: { status: "DISABLED" } }),
    db.session.deleteMany({ where: { userId: id } }),
  ]);

  await audit({
    actorId: user.id, actorEmail: user.email,
    action: "USER_DISABLED", resourceType: "USER", resourceId: id,
    metadata: { email: target.email, name: target.name, role: target.role },
    ip,
  });

  await notify({
    userId: id,
    title: "Account disabled",
    message: "Your account has been disabled. Contact your administrator if you believe this is a mistake.",
    type: "WARNING", resourceType: "USER", resourceId: id,
  });

  return ok({ id, status: "DISABLED", softDeleted: true });
});
