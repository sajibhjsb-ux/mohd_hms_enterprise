// MOHD.HMS ENTERPRISE — Users module API (detail / update / delete).
// Guards: cannot change own role, cannot disable self, non-SUPER_ADMIN cannot
// touch SUPER_ADMIN accounts. Password resets revoke all sessions.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { hashPassword, validatePasswordStrength } from "@/lib/hms/auth";
import { audit, notify, nextNumber } from "@/lib/hms/services";
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

export const GET = withId(PERMISSIONS.users_read, async (id) => {
  const u = await db.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, name: true, phone: true, role: true, status: true,
      lastLoginAt: true, createdAt: true, customerId: true,
      customer: { select: { id: true, companyName: true, code: true } },
      technicianProfile: { select: { id: true, employeeNo: true, specialty: true, skills: true, status: true } },
      employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } },
    },
  });
  if (!u) throw Errors.notFound("User not found.");
  return ok(u);
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).nullable().optional(),
  role: z.enum(["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "CUSTOMER", "FINANCE", "HR"]).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  action: z.literal("reset_password").optional(),
  newPassword: z.string().max(200).optional(),
});

export const PATCH = withId(PERMISSIONS.users_update, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const ip = clientIp(req);

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, status: true, technicianProfile: { select: { id: true } } },
  });
  if (!target) throw Errors.notFound("User not found.");

  assertNotSuperAdminTarget(target, user);

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

  // Pre-allocate a technician number OUTSIDE the transaction — nextNumber()
  // writes via the global db client, which would deadlock on SQLite inside one.
  const tecEmployeeNo = body.role === "TECHNICIAN" && !target.technicianProfile ? await nextNumber("TEC") : null;

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.phone !== undefined ? { phone: body.phone?.trim() || null } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      select: {
        id: true, email: true, name: true, phone: true, role: true, status: true,
        lastLoginAt: true, createdAt: true,
        customer: { select: { id: true, companyName: true, code: true } },
        technicianProfile: { select: { id: true, employeeNo: true, specialty: true, status: true } },
      },
    });

    // Becoming a technician: provision a profile if missing. Leaving the
    // technician role: profile is retained for history/reassignment.
    if (u.role === "TECHNICIAN" && !u.technicianProfile && tecEmployeeNo) {
      await tx.technicianProfile.create({
        data: { userId: id, employeeNo: tecEmployeeNo, specialty: "GENERAL", status: "AVAILABLE" },
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
    },
  });

  // Disabling a user kills their active sessions immediately.
  if (body.status === "DISABLED") {
    await db.session.deleteMany({ where: { userId: id } });
  }

  await audit({
    actorId: user.id, actorEmail: user.email,
    action: "USER_UPDATED", resourceType: "USER", resourceId: id,
    metadata: { email: target.email, fields: Object.keys(body).filter((k) => k !== "action"), roleFrom: target.role, roleTo: body.role ?? target.role },
    ip,
  });

  if (body.status === "DISABLED") {
    await notify({
      userId: id,
      title: "Account disabled",
      message: "Your account has been disabled by an administrator.",
      type: "WARNING", resourceType: "USER", resourceId: id,
    });
  }

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
