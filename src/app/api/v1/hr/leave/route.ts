import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

/** Leave request list (with employee + approver) — filterable by status. */
export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    const employeeId = new URL(req.url).searchParams.get("employeeId")?.trim();
    if (employeeId) where.employeeId = employeeId;

    const dir = q.dir === "asc" ? ("asc" as const) : ("desc" as const);
    const [items, total] = await Promise.all([
      db.leaveRequest.findMany({
        where,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true } },
        },
        orderBy: { createdAt: dir },
        skip: q.skip,
        take: q.take,
      }),
      db.leaveRequest.count({ where }),
    ]);

    // Resolve approver names (approvedById has no Prisma relation in the frozen schema)
    const approverIds = [...new Set(items.map((l) => l.approvedById).filter((v): v is string => Boolean(v)))];
    const approvers = approverIds.length > 0
      ? await db.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } })
      : [];
    const approverName = new Map(approvers.map((u) => [u.id, u.name]));

    return okList(
      items.map((l) => ({ ...l, approvedByName: l.approvedById ? approverName.get(l.approvedById) ?? null : null })),
      pagedMeta(q.page, q.pageSize, total)
    );
  },
  { permission: PERMISSIONS.hr_read }
);

const createSchema = z.object({
  employeeId: z.string().min(1).optional(),
  type: z.enum(["ANNUAL", "SICK", "UNPAID", "OTHER"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Start date must be YYYY-MM-DD."),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "End date must be YYYY-MM-DD."),
  reason: z.string().max(2000).optional(),
});

function dayOf(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/**
 * Create a leave request. Any staff member may file for themselves; the linked
 * employee record is resolved from the session user. Days are computed
 * server-side from the inclusive date range (client-sent values ignored).
 */
export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    let employee: Awaited<ReturnType<typeof db.employee.findFirst>> = null;
    if (body.employeeId) {
      const canFileForOthers = ["SUPER_ADMIN", "ADMIN", "HR"].includes(user.role);
      if (!canFileForOthers) throw Errors.forbidden("You can only file leave requests for yourself.");
      employee = await db.employee.findUnique({ where: { id: body.employeeId } });
      if (!employee) throw Errors.badRequest("Employee does not exist.");
    } else {
      employee = await db.employee.findFirst({ where: { userId: user.id } });
      if (!employee) throw Errors.badRequest("Your account is not linked to an employee record.");
    }

    const start = dayOf(body.startDate);
    const end = dayOf(body.endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) throw Errors.badRequest("Dates are invalid.");
    if (end < start) throw Errors.badRequest("End date cannot be before start date.");
    const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1; // inclusive

    const leave = await db.leaveRequest.create({
      data: {
        employeeId: employee.id,
        type: body.type,
        startDate: start,
        endDate: end,
        days,
        reason: body.reason ?? "",
        status: "PENDING",
      },
      include: { employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true } } },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "LEAVE_REQUESTED",
      resourceType: "LeaveRequest",
      resourceId: leave.id,
      metadata: { employee: `${employee.firstName} ${employee.lastName}`, type: body.type, days },
    });

    return ok(leave, 201);
  },
  { permission: PERMISSIONS.hr_read }
);
