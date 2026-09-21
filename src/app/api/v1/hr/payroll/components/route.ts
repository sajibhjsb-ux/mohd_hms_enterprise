// MOHD.HMS ENTERPRISE — Salary components catalog (spec §6). Configurable
// earning/deduction components; engine-managed system components are protected.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

export const GET = handler(async ({ req }) => {
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const where = {
    ...(type ? { type } : {}),
  };
  const components = await db.salaryComponent.findMany({
    where,
    orderBy: [{ category: "asc" }, { name: "asc" }],
    include: { _count: { select: { structures: true } } },
  });
  return okList(components.map((c) => ({ ...c, usageCount: c._count.structures, _count: undefined })));
}, { permission: PERMISSIONS.payroll_read });

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  type: z.enum(["EARNING", "DEDUCTION"]),
  category: z.enum(["ALLOWANCE", "BONUS", "COMMISSION", "REIMBURSEMENT", "OTHER", "LOAN", "ABSENCE"]),
  description: z.string().trim().max(300).optional(),
  taxable: z.boolean().optional(),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);
  const dup = await db.salaryComponent.findUnique({ where: { name: body.name } });
  if (dup) throw Errors.conflict(`Component "${body.name}" already exists.`);
  const component = await db.salaryComponent.create({
    data: { ...body, description: body.description ?? "", createdById: user.id },
  });
  await audit({
    actorId: user.id, actorEmail: user.email, action: "PAYROLL_COMPONENT_CREATED",
    resourceType: "SALARY_COMPONENT", resourceId: component.id,
    metadata: { name: component.name, type: component.type, category: component.category },
  });
  return ok(component, 201);
}, { permission: PERMISSIONS.payroll_manage });
