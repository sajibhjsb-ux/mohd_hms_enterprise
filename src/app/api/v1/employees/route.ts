// MOHD.HMS ENTERPRISE — Employees module API (list / create).
// Money: salary received as decimal BND, stored as integer cents.
// LIST CONTRACT (consumed by other modules): items shaped
// { id, employeeNo, firstName, lastName, position, email, phone, status,
//   salaryCents, joinDate, departmentId, department: { id, name } | null }

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, Errors, parseBody, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";
import { toCents } from "@/lib/hms/format";
import { clientIp } from "@/lib/hms/rate-limit";

const EMPLOYEE_LIST_SELECT = {
  id: true,
  employeeNo: true,
  firstName: true,
  lastName: true,
  position: true,
  email: true,
  phone: true,
  status: true,
  salaryCents: true,
  joinDate: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

const SORT_FIELDS = ["createdAt", "employeeNo", "firstName", "lastName", "status"] as const;

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const where: Prisma.EmployeeWhereInput = {};

    if (q.status) where.status = q.status.toUpperCase();
    if (q.search) {
      where.OR = [
        { firstName: { contains: q.search } },
        { lastName: { contains: q.search } },
        { employeeNo: { contains: q.search } },
        { email: { contains: q.search } },
        { position: { contains: q.search } },
      ];
    }

    const sortField = (SORT_FIELDS as readonly string[]).includes(q.sort) ? (q.sort as (typeof SORT_FIELDS)[number]) : "createdAt";

    const [items, total] = await Promise.all([
      db.employee.findMany({
        where,
        orderBy: { [sortField]: q.dir },
        skip: q.skip,
        take: q.take,
        select: EMPLOYEE_LIST_SELECT,
      }),
      db.employee.count({ where }),
    ]);

    return okList(items, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.employees_read }
);

const createSchema = z.object({
  employeeNo: z.string().max(40).optional(),
  firstName: z.string().min(1, "First name is required.").max(100),
  lastName: z.string().min(1, "Last name is required.").max(100),
  departmentId: z.string().min(1).nullish(),
  position: z.string().max(120).optional(),
  email: z.union([z.string().email("Enter a valid email address."), z.literal("")]).optional(),
  phone: z.string().max(40).optional(),
  joinDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use a valid date (YYYY-MM-DD).")
    .optional(),
  salary: z.union([z.number(), z.string()]).optional(),
  userId: z.string().min(1).nullish(),
  status: z.enum(["ACTIVE", "ON_LEAVE", "TERMINATED"]).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const ip = clientIp(req);

    if (body.departmentId) {
      const dept = await db.department.findUnique({ where: { id: body.departmentId }, select: { id: true } });
      if (!dept) throw Errors.badRequest("Selected department does not exist.", [{ path: "departmentId", message: "Unknown department." }]);
    }
    if (body.userId) {
      const linked = await db.employee.findUnique({ where: { userId: body.userId }, select: { id: true } });
      if (linked) throw Errors.conflict("This user account is already linked to another employee.");
    }

    const employeeNo = body.employeeNo?.trim() || (await nextNumber("EMP"));

    const dupNo = await db.employee.findUnique({ where: { employeeNo }, select: { id: true } });
    if (dupNo) throw Errors.conflict(`Employee number ${employeeNo} is already in use.`);

    const employee = await db.employee.create({
      data: {
        employeeNo,
        firstName: body.firstName.trim(),
        lastName: body.lastName.trim(),
        departmentId: body.departmentId || null,
        position: body.position?.trim() ?? "",
        email: body.email?.trim() ?? "",
        phone: body.phone?.trim() ?? "",
        joinDate: body.joinDate ? new Date(body.joinDate) : null,
        salaryCents: body.salary !== undefined ? toCents(body.salary) : 0,
        userId: body.userId || null,
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      select: EMPLOYEE_LIST_SELECT,
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "EMPLOYEE_CREATED",
      resourceType: "EMPLOYEE",
      resourceId: employee.id,
      metadata: { employeeNo, name: `${employee.firstName} ${employee.lastName}` },
      ip,
    });

    return ok(employee, 201);
  },
  { permission: PERMISSIONS.employees_create }
);
