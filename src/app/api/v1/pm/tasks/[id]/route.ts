import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const GET = withId(
  async (id) => {
    const task = await db.pmTask.findUnique({
      where: { id },
      include: {
        plan: { select: { id: true, name: true, code: true, frequency: true, checklistTemplate: true } },
        equipment: { select: { id: true, name: true, assetTag: true } },
        technician: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
        checklist: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!task) throw Errors.notFound("PM task not found.");

    // Keep overdue state fresh on detail view too
    if (task.status === "SCHEDULED" && task.dueDate.getTime() < Date.now()) {
      await db.pmTask.update({ where: { id: task.id }, data: { status: "OVERDUE" } }).catch(() => undefined);
      task.status = "OVERDUE";
    }

    return ok(task);
  },
  PERMISSIONS.pm_read
);

const patchSchema = z.object({
  technicianId: z.string().min(1).nullish(),
  dueDate: z.string().nullish(),
  notes: z.string().max(2000).nullish(),
});

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);

    const task = await db.pmTask.findUnique({ where: { id } });
    if (!task) throw Errors.notFound("PM task not found.");
    if (["COMPLETED", "SKIPPED"].includes(task.status)) {
      throw Errors.invalidTransition("Completed or skipped tasks cannot be rescheduled.");
    }
    if (body.technicianId) {
      const tech = await db.technicianProfile.findUnique({ where: { id: body.technicianId } });
      if (!tech) throw Errors.badRequest("Technician does not exist.");
    }
    let dueDate: Date | undefined;
    if (body.dueDate !== undefined && body.dueDate !== null) {
      const d = new Date(body.dueDate);
      if (isNaN(d.getTime())) throw Errors.badRequest("Due date is invalid.");
      dueDate = d;
    }

    const updated = await db.pmTask.update({
      where: { id },
      data: {
        ...(body.technicianId !== undefined ? { technicianId: body.technicianId ?? null } : {}),
        ...(body.dueDate !== undefined ? { dueDate: dueDate ?? task.dueDate } : {}),
        ...(body.notes !== undefined ? { notes: body.notes ?? "" } : {}),
      },
      include: {
        plan: { select: { id: true, name: true, code: true } },
        equipment: { select: { id: true, name: true, assetTag: true } },
        technician: { select: { id: true, user: { select: { name: true } } } },
        checklist: { orderBy: { sortOrder: "asc" } },
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_TASK_UPDATED",
      resourceType: "PmTask",
      resourceId: id,
      metadata: { code: task.code, fields: Object.keys(body) },
    });

    return ok(updated);
  },
  PERMISSIONS.pm_manage
);
