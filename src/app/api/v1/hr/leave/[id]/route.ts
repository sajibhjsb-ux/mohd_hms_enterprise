import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, notify } from "@/lib/hms/services";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const patchSchema = z.object({
  action: z.enum(["approve", "reject"]),
  notes: z.string().max(1000).optional(),
});

/** Approve / reject a pending leave request (hr.manage). Notifies the employee's linked user. */
export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);

    const leave = await db.leaveRequest.findUnique({
      where: { id },
      include: { employee: { select: { id: true, firstName: true, lastName: true, userId: true } } },
    });
    if (!leave) throw Errors.notFound("Leave request not found.");
    if (leave.status !== "PENDING") {
      throw Errors.invalidTransition(`This leave request was already ${leave.status.toLowerCase()}.`);
    }

    const now = new Date();
    const status = body.action === "approve" ? "APPROVED" : "REJECTED";
    const updated = await db.leaveRequest.update({
      where: { id },
      data: { status, approvedById: user.id, approvedAt: now },
      include: { employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true, userId: true } } },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: body.action === "approve" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
      resourceType: "LeaveRequest",
      resourceId: id,
      metadata: {
        employee: `${leave.employee.firstName} ${leave.employee.lastName}`,
        type: leave.type,
        days: leave.days,
      },
    });

    if (updated.employee.userId) {
      await notify({
        userId: updated.employee.userId,
        title: `Leave request ${status.toLowerCase()}`,
        message: `Your ${leave.type.toLowerCase()} leave (${leave.days} day${leave.days === 1 ? "" : "s"}) was ${status.toLowerCase()} by ${user.name}.`,
        type: status === "APPROVED" ? "SUCCESS" : "WARNING",
        resourceType: "LeaveRequest",
        resourceId: id,
      });
    }

    return ok(updated);
  },
  PERMISSIONS.hr_manage
);
