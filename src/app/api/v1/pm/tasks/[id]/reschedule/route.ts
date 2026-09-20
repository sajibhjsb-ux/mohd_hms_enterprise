// MOHD.HMS ENTERPRISE — PM occurrence reschedule (PM §73).
// POST /api/v1/pm/tasks/[id]/reschedule — dates are NEVER silently moved: every
// change is audited with from/to/reason, the execution work order is kept in
// sync, and the assigned technician is notified.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, notify } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const CLOSED_STATUSES = ["COMPLETED", "SKIPPED", "CANCELLED", "FAILED"];
const WO_TERMINAL_STATUSES = ["COMPLETED", "CANCELLED"];

const rescheduleSchema = z.object({
  dueDate: z.string().min(1, "New due date is required."),
  reason: z.string().min(3, "A reason of at least 3 characters is required.").max(2000),
});

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, rescheduleSchema);
    const dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) throw Errors.badRequest("dueDate must be a valid ISO date.");

    const task = await db.pmTask.findUnique({
      where: { id },
      include: {
        workOrder: { select: { id: true, status: true } },
        technician: { select: { user: { select: { id: true, name: true } } } },
      },
    });
    if (!task) throw Errors.notFound("PM task not found.");
    if (CLOSED_STATUSES.includes(task.status)) {
      throw Errors.invalidTransition("Closed occurrences cannot be rescheduled.");
    }

    const fromDueDate = task.dueDate;
    await db.$transaction(async (tx) => {
      await tx.pmTask.update({
        where: { id },
        data: {
          dueDate,
          rescheduleReason: body.reason,
          rescheduledAt: new Date(),
          rescheduledById: user.id,
        },
      });
      // Keep the execution work order schedule aligned (§24 — one source of truth).
      if (task.workOrderId && task.workOrder && !WO_TERMINAL_STATUSES.includes(task.workOrder.status)) {
        await tx.workOrder.update({ where: { id: task.workOrderId }, data: { scheduledDate: dueDate } });
      }
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_RESCHEDULED",
      resourceType: "PmTask",
      resourceId: id,
      metadata: {
        code: task.code,
        fromDueDate: fromDueDate.toISOString(),
        toDueDate: dueDate.toISOString(),
        reason: body.reason,
      },
    });

    if (task.technician?.user?.id) {
      await notify({
        userId: task.technician.user.id,
        title: "PM task rescheduled",
        message: `${task.code} due date moved from ${fromDueDate.toISOString().slice(0, 10)} to ${dueDate.toISOString().slice(0, 10)}. Reason: ${body.reason}`,
        type: "INFO",
        resourceType: "PM_TASK",
        resourceId: id,
      });
    }

    // Realtime: calendar/dashboard views update live.
    await emit({
      type: EVENT_TYPES.PM_TASK_UPDATED,
      resourceType: "PmTask",
      resourceId: id,
      payload: { code: task.code, fields: ["dueDate", "rescheduleReason"] },
      actorType: "USER",
      actorId: user.id,
    });

    const updated = await db.pmTask.findUnique({
      where: { id },
      include: {
        plan: { select: { id: true, name: true, code: true } },
        equipment: { select: { id: true, name: true, assetTag: true } },
        technician: { select: { id: true, user: { select: { name: true } } } },
        workOrder: { select: { id: true, code: true, status: true, scheduledDate: true } },
      },
    });
    return ok(updated);
  },
  PERMISSIONS.pm_manage
);
