// MOHD.HMS ENTERPRISE — Position catalog API (detail / update / deactivate).
// Spec §24: positions are DEACTIVATED, never hard-deleted, so historical
// employee records and audit history stay valid. The [id] DELETE endpoint is
// therefore a soft-deactivate (idempotent); reactivation is a PATCH.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";

const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

const POSITION_SELECT = {
  id: true,
  name: true,
  description: true,
  status: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { employees: true, users: true } },
};

export const GET = withId(PERMISSIONS.employees_read, async (id) => {
  const position = await db.jobPosition.findUnique({ where: { id }, select: POSITION_SELECT });
  if (!position) throw Errors.notFound("Position not found.");
  return ok({ ...position, inUse: position._count.employees + position._count.users });
});

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  departmentId: z.string().min(1).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const PATCH = withId(PERMISSIONS.hr_manage, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);

  const existing = await db.jobPosition.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
  if (!existing) throw Errors.notFound("Position not found.");

  if (body.name !== undefined && body.name.trim() !== existing.name) {
    const taken = await db.jobPosition.findUnique({ where: { name: body.name.trim() }, select: { id: true } });
    if (taken) throw Errors.conflict(`A position named “${body.name.trim()}” already exists.`);
  }
  if (body.departmentId) {
    const dept = await db.department.findUnique({ where: { id: body.departmentId }, select: { id: true } });
    if (!dept) throw Errors.badRequest("Selected department does not exist.", [{ path: "departmentId", message: "Unknown department." }]);
  }

  const position = await db.jobPosition.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.description !== undefined ? { description: body.description.trim() } : {}),
      ...(body.departmentId !== undefined ? { departmentId: body.departmentId || null } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      updatedBy: user.id,
    },
    select: POSITION_SELECT,
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "POSITION_UPDATED",
    resourceType: "JobPosition",
    resourceId: id,
    metadata: {
      name: position.name,
      ...(body.status !== undefined && body.status !== existing.status
        ? { statusFrom: existing.status, statusTo: body.status }
        : {}),
      ...(body.name !== undefined && body.name.trim() !== existing.name
        ? { nameFrom: existing.name, nameTo: body.name.trim() }
        : {}),
      fields: Object.keys(body),
    },
  });

  return ok({ ...position, inUse: position._count.employees + position._count.users });
});

// Soft-deactivate (spec §24) — historical employee records keep their FK.
export const DELETE = withId(PERMISSIONS.hr_manage, async (id, { req, user }) => {
  const existing = await db.jobPosition.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
  if (!existing) throw Errors.notFound("Position not found.");

  if (existing.status === "INACTIVE") {
    return ok({ id, status: "INACTIVE", deactivated: false, alreadyInactive: true });
  }

  const position = await db.jobPosition.update({
    where: { id },
    data: { status: "INACTIVE", updatedBy: user.id },
    select: { id: true, name: true, status: true },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "POSITION_DEACTIVATED",
    resourceType: "JobPosition",
    resourceId: id,
    metadata: { name: existing.name },
  });

  return ok({ ...position, deactivated: true });
});
