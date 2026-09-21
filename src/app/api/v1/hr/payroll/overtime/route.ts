// MOHD.HMS ENTERPRISE — Overtime requests (spec §15). Follows the existing HR
// leave architecture: PENDING → APPROVED/REJECTED via hr.manage; the payable
// amount is computed SERVER-SIDE from the employee's basic salary at approval
// time and snapshotted — employees can never modify payable overtime.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

export const GET = handler(async ({ req }) => {
  const { page, pageSize, skip, take, status } = listQuery(req);
  const url = new URL(req.url);
  const employeeId = url.searchParams.get("employeeId");
  const where = {
    ...(status ? { status } : {}),
    ...(employeeId ? { employeeId } : {}),
  };
  const [items, total] = await Promise.all([
    db.overtimeRequest.findMany({
      where,
      orderBy: { date: "desc" },
      skip,
      take,
      include: {
        employee: { select: { employeeNo: true, firstName: true, lastName: true } },
        approver: { select: { name: true } },
      },
    }),
    db.overtimeRequest.count({ where }),
  ]);
  return okList(
    items.map((o) => ({
      id: o.id,
      employeeId: o.employeeId,
      employeeNo: o.employee.employeeNo,
      employeeName: `${o.employee.firstName} ${o.employee.lastName}`.trim(),
      date: o.date,
      hours: o.minutes / 60,
      multiplier: o.multiplier,
      reason: o.reason,
      status: o.status,
      amountCents: o.amountCents,
      rateBasisCents: o.rateBasisCents,
      approvedAt: o.approvedAt,
      approvedByName: o.approver?.name ?? "",
      createdAt: o.createdAt,
    })),
    pagedMeta(page, pageSize, total),
  );
}, { permission: PERMISSIONS.hr_read });

const createSchema = z.object({
  employeeId: z.string().optional(),
  date: z.string().min(10),
  hours: z.coerce.number().positive().max(24),
  multiplier: z.coerce.number().min(1).max(4).optional(),
  reason: z.string().trim().max(300).optional(),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);

  // Self-filing resolves the employee via the linked account; specifying an
  // employeeId requires hr.manage (same rule as the existing leave route).
  let employeeId = body.employeeId;
  if (employeeId && employeeId !== "__self__") {
    if (!user.permissions.includes(PERMISSIONS.hr_manage)) {
      throw Errors.forbidden("Only HR managers can file overtime for other employees.");
    }
  } else {
    const self = await db.employee.findUnique({ where: { userId: user.id } });
    if (!self) throw Errors.badRequest("No employee record is linked to your account.");
    employeeId = self.id;
  }

  const employee = await db.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw Errors.notFound("Employee not found.");
  if (employee.status === "TERMINATED") throw Errors.badRequest("Terminated employees cannot file overtime.");

  const ot = await db.overtimeRequest.create({
    data: {
      employeeId: employee.id,
      date: new Date(body.date),
      minutes: Math.round(body.hours * 60),
      multiplier: body.multiplier ?? 1.5,
      reason: body.reason ?? "",
      createdById: user.id,
    },
  });

  await audit({
    actorId: user.id, actorEmail: user.email, action: "OVERTIME_REQUESTED",
    resourceType: "OVERTIME_REQUEST", resourceId: ot.id,
    metadata: { employeeNo: employee.employeeNo, date: body.date, hours: body.hours, multiplier: ot.multiplier },
  });
  await emit({ type: EVENT_TYPES.HR_OVERTIME_UPDATED, resourceType: "OvertimeRequest", resourceId: ot.id, payload: { status: "PENDING" }, actorType: "USER", actorId: user.id });
  return ok(ot, 201);
}, { permission: PERMISSIONS.hr_read });
