// MOHD.HMS ENTERPRISE — Position catalog API (list / create).
// Positions are HR master data: managed job titles (e.g. "Finance Director")
// SEPARATE from application roles. ROLE = RBAC access; POSITION = job title.
// READ is allowed to anyone who can read the employee register (dropdowns in
// User Management / Employees need it); create is hr.manage — the same RBAC
// rule that governs departments.

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

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
} satisfies Prisma.JobPositionSelect;

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const where: Prisma.JobPositionWhereInput = {};
    // ?status=ACTIVE|INACTIVE — dropdowns pass ACTIVE; management pages omit it.
    if (q.status) where.status = q.status.toUpperCase();
    if (q.search) {
      where.OR = [{ name: { contains: q.search } }, { description: { contains: q.search } }];
    }

    const [items, total] = await Promise.all([
      db.jobPosition.findMany({
        where,
        orderBy: [{ name: "asc" }],
        skip: q.skip,
        take: q.take,
        select: POSITION_SELECT,
      }),
      db.jobPosition.count({ where }),
    ]);

    return okList(
      items.map((p) => ({ ...p, inUse: p._count.employees + p._count.users })),
      pagedMeta(q.page, q.pageSize, total)
    );
  },
  { permission: PERMISSIONS.employees_read }
);

const createSchema = z.object({
  name: z.string().min(2, "Position name is required.").max(120),
  description: z.string().max(500).optional(),
  departmentId: z.string().min(1).nullish(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const name = body.name.trim();

    const existing = await db.jobPosition.findUnique({ where: { name } });
    if (existing) throw Errors.conflict(`A position named “${name}” already exists.`);

    if (body.departmentId) {
      const dept = await db.department.findUnique({ where: { id: body.departmentId }, select: { id: true } });
      if (!dept) throw Errors.badRequest("Selected department does not exist.", [{ path: "departmentId", message: "Unknown department." }]);
    }

    const position = await db.jobPosition.create({
      data: {
        name,
        description: body.description?.trim() ?? "",
        departmentId: body.departmentId || null,
        createdBy: user.id,
        updatedBy: user.id,
      },
      select: POSITION_SELECT,
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "POSITION_CREATED",
      resourceType: "JobPosition",
      resourceId: position.id,
      metadata: { name },
    });

    return ok({ ...position, inUse: 0 }, 201);
  },
  { permission: PERMISSIONS.hr_manage }
);
