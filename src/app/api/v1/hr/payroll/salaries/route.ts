// MOHD.HMS ENTERPRISE — Employee salary structures (spec §5/§6/§7).
// Effective-dated component assignments. Creating a new version ENDS the
// overlapping current row of the same component (history preserved, never
// overwritten). BASIC changes mirror the canonical Employee.salaryCents.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { toCents } from "@/lib/hms/format";

export const GET = handler(async ({ req }) => {
  const url = new URL(req.url);
  const employeeId = url.searchParams.get("employeeId");
  const componentId = url.searchParams.get("componentId");
  const where = {
    ...(employeeId ? { employeeId } : {}),
    ...(componentId ? { componentId } : {}),
  };
  const structures = await db.salaryStructure.findMany({
    where,
    orderBy: { effectiveFrom: "desc" },
    take: 500,
    include: {
      employee: { select: { employeeNo: true, firstName: true, lastName: true, salaryCents: true } },
      component: { select: { name: true, category: true, type: true } },
    },
  });
  return ok(structures.map((s) => ({
    id: s.id,
    employeeId: s.employeeId,
    employeeNo: s.employee.employeeNo,
    employeeName: `${s.employee.firstName} ${s.employee.lastName}`.trim(),
    componentId: s.componentId,
    componentName: s.component.name,
    componentCategory: s.component.category,
    componentType: s.component.type,
    amountCents: s.amountCents,
    percentBps: s.percentBps,
    effectiveFrom: s.effectiveFrom,
    effectiveTo: s.effectiveTo,
    note: s.note,
    currentBasicCents: s.employee.salaryCents,
  })));
}, { permission: PERMISSIONS.payroll_read });

const createSchema = z.object({
  employeeId: z.string().min(1),
  componentId: z.string().min(1),
  amount: z.union([z.coerce.number(), z.string()]).optional(),
  percentBps: z.coerce.number().int().min(0).max(10000).optional(),
  effectiveFrom: z.string().min(10),
  note: z.string().trim().max(300).optional(),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);
  const employee = await db.employee.findUnique({ where: { id: body.employeeId } });
  if (!employee) throw Errors.notFound("Employee not found.");
  const component = await db.salaryComponent.findUnique({ where: { id: body.componentId } });
  if (!component) throw Errors.notFound("Salary component not found.");
  if (!component.active) throw Errors.badRequest("Component is inactive.");
  if (component.category === "BASIC" && body.amount == null) {
    throw Errors.badRequest("Basic salary requires an amount.");
  }
  if (body.amount == null && !body.percentBps) {
    throw Errors.badRequest("Provide an amount or a percentage.");
  }

  const effectiveFrom = new Date(body.effectiveFrom);
  const amountCents = body.amount != null ? toCents(body.amount) : 0;
  const previousSalaryCents = employee.salaryCents;

  const structure = await db.$transaction(async (tx) => {
    // End any current (open) version of the SAME component the day before.
    await tx.salaryStructure.updateMany({
      where: { employeeId: employee.id, componentId: component.id, effectiveTo: null },
      data: { effectiveTo: new Date(effectiveFrom.getTime() - 86_400_000) },
    });
    const created = await tx.salaryStructure.create({
      data: {
        employeeId: employee.id,
        componentId: component.id,
        amountCents,
        percentBps: body.percentBps ?? null,
        effectiveFrom,
        note: body.note ?? "",
        createdById: user.id,
      },
    });
    // Canonical mirror: current basic salary stays on the Employee record.
    if (component.category === "BASIC" && effectiveFrom.getTime() <= Date.now() && amountCents !== previousSalaryCents) {
      await tx.employee.update({ where: { id: employee.id }, data: { salaryCents: amountCents } });
    }
    return created;
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "SALARY_STRUCTURE_CREATED",
    resourceType: "SALARY_STRUCTURE", resourceId: structure.id,
    metadata: {
      employeeNo: employee.employeeNo, component: component.name,
      amountCents, percentBps: body.percentBps ?? null,
      effectiveFrom: effectiveFrom.toISOString(),
      previousBasicCents: component.category === "BASIC" ? previousSalaryCents : undefined,
      newBasicCents: component.category === "BASIC" ? employee.salaryCents : undefined,
    },
  });
  await emit({ type: EVENT_TYPES.PAYROLL_RUN_UPDATED, resourceType: "Employee", resourceId: employee.id, payload: { kind: "SALARY_STRUCTURE" }, actorType: "USER", actorId: user.id });
  return ok(structure, 201);
}, { permission: PERMISSIONS.payroll_manage });
