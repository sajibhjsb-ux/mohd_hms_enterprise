import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

/** Department list with headcounts — readable by hr OR plain employees readers. */
export const GET = handler(
  async () => {
    const departments = await db.department.findMany({
      include: { _count: { select: { employees: true } } },
      orderBy: { name: "asc" },
    });
    return okList(departments.map((d) => ({ id: d.id, name: d.name, description: d.description, employeeCount: d._count.employees })));
  },
  { permission: PERMISSIONS.employees_read }
);

const createSchema = z.object({
  name: z.string().min(2, "Department name is required.").max(120),
  description: z.string().max(500).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const name = body.name.trim();

    const existing = await db.department.findFirst({ where: { name: { equals: name } } });
    if (existing) throw Errors.conflict(`A department named “${name}” already exists.`);

    const department = await db.department.create({
      data: { name, description: body.description ?? "" },
      include: { _count: { select: { employees: true } } },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "DEPARTMENT_CREATED",
      resourceType: "Department",
      resourceId: department.id,
      metadata: { name },
    });

    return ok({ ...department, employeeCount: department._count.employees }, 201);
  },
  { permission: PERMISSIONS.hr_manage }
);
