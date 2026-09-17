import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify, notifyRole } from "@/lib/hms/services";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c))(req);
  };
}

const transitionSchema = z.object({
  action: z.enum(["start", "complete", "skip"]),
  notes: z.string().max(2000).optional(),
  force: z.boolean().optional(),
  checklist: z.array(z.object({ id: z.string(), done: z.boolean() })).optional(),
});

/** Lifecycle: SCHEDULED/OVERDUE → IN_PROGRESS → COMPLETED (or SKIPPED by managers). */
export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, transitionSchema);

    const task = await db.pmTask.findUnique({
      where: { id },
      include: {
        plan: { select: { id: true, name: true, code: true } },
        equipment: { select: { id: true, name: true, assetTag: true } },
        technician: { select: { id: true, userId: true, user: { select: { name: true } } } },
        checklist: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!task) throw Errors.notFound("PM task not found.");

    const canManage = roleCan(user.role, PERMISSIONS.pm_manage);
    const canExecute = roleCan(user.role, PERMISSIONS.pm_execute);
    const isAssigned = task.technician?.userId === user.id;

    // Optionally persist checklist toggles supplied alongside the transition
    if (body.checklist && body.checklist.length > 0) {
      const ownedIds = new Set(task.checklist.map((c) => c.id));
      const valid = body.checklist.filter((c) => ownedIds.has(c.id));
      await db.$transaction(
        valid.map((c) => db.pmTaskChecklistItem.update({ where: { id: c.id }, data: { done: c.done } }))
      );
    }

    if (body.action === "start") {
      if (!canExecute && !canManage && !isAssigned) throw Errors.forbidden("Only the assigned technician can start this task.");
      if (!["SCHEDULED", "OVERDUE"].includes(task.status)) {
        throw Errors.invalidTransition(`Cannot start a task in status ${task.status}.`);
      }
      const updated = await db.pmTask.update({
        where: { id },
        data: { status: "IN_PROGRESS", ...(body.notes !== undefined ? { notes: body.notes } : {}) },
      });
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PM_TASK_STARTED",
        resourceType: "PmTask",
        resourceId: id,
        metadata: { code: task.code },
      });
      return ok(updated);
    }

    if (body.action === "complete") {
      if (!canExecute && !canManage && !isAssigned) throw Errors.forbidden("Only the assigned technician can complete this task.");
      if (task.status === "COMPLETED") throw Errors.invalidTransition("Task is already completed.");
      if (task.status === "SKIPPED") throw Errors.invalidTransition("Skipped tasks cannot be completed.");

      const items = await db.pmTaskChecklistItem.findMany({ where: { taskId: id } });
      const allDone = items.length === 0 || items.every((i) => i.done);
      if (!allDone && !(body.force && canManage)) {
        throw Errors.invalidTransition(
          `All checklist items must be completed before finishing this task (${items.filter((i) => i.done).length}/${items.length} done).`
        );
      }

      const now = new Date();
      const updated = await db.$transaction(async (tx) => {
        // Mark all checklist items done (final sweep)
        await tx.pmTaskChecklistItem.updateMany({ where: { taskId: id }, data: { done: true } });
        return tx.pmTask.update({
          where: { id },
          data: { status: "COMPLETED", completedAt: now, notes: body.notes ?? task.notes },
          include: {
            plan: { select: { id: true, name: true, code: true } },
            equipment: { select: { id: true, name: true, assetTag: true } },
            technician: { select: { id: true, user: { select: { name: true } } } },
            checklist: { orderBy: { sortOrder: "asc" } },
          },
        });
      });

      // Record maintenance completion on the plan (drives schedule health)
      await db.pmPlan.update({ where: { id: task.planId }, data: { lastCompletedAt: now } }).catch(() => undefined);

      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PM_COMPLETED",
        resourceType: "PmTask",
        resourceId: id,
        metadata: { code: task.code, planCode: task.plan.code, equipment: task.equipment.name, forced: Boolean(body.force && canManage) },
      });
      await notifyRole("SUPERVISOR", {
        title: "PM task completed",
        message: `${user.name} completed ${task.code} — ${task.plan.name} on ${task.equipment.name}.`,
        type: "SUCCESS",
        resourceType: "PmTask",
        resourceId: id,
      });
      return ok(updated);
    }

    // action === "skip"
    if (!canManage) throw Errors.forbidden("Only supervisors can skip PM tasks.");
    if (["COMPLETED", "SKIPPED"].includes(task.status)) {
      throw Errors.invalidTransition(`Task is already ${task.status.toLowerCase()}.`);
    }
    const skipped = await db.pmTask.update({
      where: { id },
      data: { status: "SKIPPED", notes: body.notes ?? task.notes },
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
      action: "PM_TASK_SKIPPED",
      resourceType: "PmTask",
      resourceId: id,
      metadata: { code: task.code, reason: body.notes ?? "" },
    });
    return ok(skipped);
  }
);
