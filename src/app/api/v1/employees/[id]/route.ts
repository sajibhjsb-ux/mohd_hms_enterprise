// MOHD.HMS ENTERPRISE — Employees module API (detail / update / delete).
// DELETE is a soft terminate (status TERMINATED) to protect payroll history.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";
import { toCents } from "@/lib/hms/format";
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

export const GET = withId(PERMISSIONS.employees_read, async (id) => {
  const employee = await db.employee.findUnique({
    where: { id },
    include: {
      department: { select: { id: true, name: true, description: true } },
      positionRef: { select: { id: true, name: true, status: true } },
      user: { select: { id: true, email: true, name: true, role: true } },
    },
  });
  if (!employee) throw Errors.notFound("Employee not found.");
  return ok(employee);
});

const patchSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  departmentId: z.string().min(1).nullable().optional(),
  position: z.string().max(120).optional(),
  // Managed job title from the position catalog (role/position spec §13) —
  // independent from the linked account's ROLE. Clearing (null) is allowed.
  positionId: z.string().min(1).nullable().optional(),
  email: z.union([z.string().email("Enter a valid email address."), z.literal("")]).optional(),
  phone: z.string().max(40).optional(),
  address: z.string().max(500).optional(),
  joinDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use a valid date (YYYY-MM-DD).")
    .nullable()
    .optional(),
  salary: z.union([z.number(), z.string()]).optional(),
  status: z.enum(["ACTIVE", "ON_LEAVE", "TERMINATED"]).optional(),
  userId: z.string().min(1).nullable().optional(),
});

export const PATCH = withId(PERMISSIONS.employees_update, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const ip = clientIp(req);

  const existing = await db.employee.findUnique({
    where: { id },
    select: { id: true, employeeNo: true, position: true, positionId: true, userId: true },
  });
  if (!existing) throw Errors.notFound("Employee not found.");

  if (body.departmentId) {
    const dept = await db.department.findUnique({ where: { id: body.departmentId }, select: { id: true } });
    if (!dept) throw Errors.badRequest("Selected department does not exist.", [{ path: "departmentId", message: "Unknown department." }]);
  }
  if (body.userId) {
    const linked = await db.employee.findFirst({ where: { userId: body.userId, id: { not: id } }, select: { id: true } });
    if (linked) throw Errors.conflict("This user account is already linked to another employee.");
  }

  // ── Position validation (role/position spec §29) ──
  // Catalog title must exist and be ACTIVE; a free-text position cannot be
  // combined with a catalog position in the same request.
  let positionPatch: { positionId: string | null; position: string } | null = null;
  if (body.positionId !== undefined) {
    if (body.positionId !== null) {
      const pos = await db.jobPosition.findUnique({ where: { id: body.positionId }, select: { id: true, name: true, status: true } });
      if (!pos) throw Errors.badRequest("Selected position does not exist.", [{ path: "positionId", message: "Unknown position." }]);
      if (pos.status !== "ACTIVE" && pos.id !== existing.positionId) {
        throw Errors.badRequest("This position is inactive and cannot be assigned.", [{ path: "positionId", message: "Position is inactive." }]);
      }
      if (body.position !== undefined) {
        throw Errors.badRequest("Send either positionId or a free-text position — not both.", [{ path: "positionId", message: "Ambiguous position." }]);
      }
      positionPatch = { positionId: pos.id, position: pos.name }; // snapshot for letters/attendance/profile
    } else {
      positionPatch = { positionId: null, position: body.position?.trim() ?? "" };
    }
  }

  // Position history context (role/position spec §15/§16) — resolved BEFORE
  // the write so the audit carries the previous title.
  const previousPositionName = existing.position;

  const employee = await db.$transaction(async (tx) => {
    const e = await tx.employee.update({
      where: { id },
      data: {
        ...(body.firstName !== undefined ? { firstName: body.firstName.trim() } : {}),
        ...(body.lastName !== undefined ? { lastName: body.lastName.trim() } : {}),
        ...(body.departmentId !== undefined ? { departmentId: body.departmentId || null } : {}),
        ...(body.position !== undefined && positionPatch === null ? { position: body.position.trim() } : {}),
        ...(positionPatch ? positionPatch : {}),
        ...(body.email !== undefined ? { email: body.email.trim() } : {}),
        ...(body.phone !== undefined ? { phone: body.phone.trim() } : {}),
        ...(body.address !== undefined ? { address: body.address.trim() } : {}),
        ...(body.joinDate !== undefined ? { joinDate: body.joinDate ? new Date(body.joinDate) : null } : {}),
        ...(body.salary !== undefined ? { salaryCents: toCents(body.salary) } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.userId !== undefined ? { userId: body.userId || null } : {}),
      },
      include: {
        department: { select: { id: true, name: true } },
        positionRef: { select: { id: true, name: true, status: true } },
      },
    });

    // One person, ONE job title: the linked account follows the employee's
    // position (display field only — it never touches User.role or
    // permissions, spec §13/§22).
    if (positionPatch && e.userId) {
      await tx.user.update({ where: { id: e.userId }, data: { positionId: positionPatch.positionId } });
    }
    return e;
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "EMPLOYEE_UPDATED",
    resourceType: "EMPLOYEE",
    resourceId: id,
    metadata: { employeeNo: existing.employeeNo, fields: Object.keys(body) },
    ip,
  });

  // Dedicated position-change audit (spec §15) — previous → new job title.
  if (positionPatch) {
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "EMPLOYEE_POSITION_CHANGED",
      resourceType: "EMPLOYEE",
      resourceId: id,
      metadata: {
        employeeNo: existing.employeeNo,
        previousPosition: previousPositionName || null,
        newPosition: positionPatch.position || null,
        ...(employee.userId ? { mirroredToUserId: employee.userId } : {}),
        result: "SUCCESS",
      },
      ip,
    });
  }

  return ok(employee);
});

export const DELETE = withId(PERMISSIONS.employees_delete, async (id, { req, user }) => {
  const ip = clientIp(req);

  const existing = await db.employee.findUnique({ where: { id }, select: { id: true, employeeNo: true, status: true } });
  if (!existing) throw Errors.notFound("Employee not found.");

  if (existing.status === "TERMINATED") {
    throw Errors.conflict("Employee record is already terminated.");
  }

  const employee = await db.employee.update({
    where: { id },
    data: { status: "TERMINATED" },
    include: { department: { select: { id: true, name: true } } },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "EMPLOYEE_TERMINATED",
    resourceType: "EMPLOYEE",
    resourceId: id,
    metadata: { employeeNo: existing.employeeNo },
    ip,
  });

  return ok(employee);
});
