import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { recalcWorkOrderTotals } from "@/app/api/v1/work-orders/_lib";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c))(req);
  };
}

const transitionSchema = z.object({
  action: z.enum(["start", "complete", "skip", "fail"]),
  notes: z.string().max(2000).optional(),
  force: z.boolean().optional(),
  checklist: z.array(z.object({ id: z.string(), done: z.boolean() })).optional(),
  // §75 — fail requires a recorded finding (created atomically)
  finding: z
    .object({
      title: z.string().min(3).max(300),
      description: z.string().max(4000).default(""),
      severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
      cause: z.string().max(2000).default(""),
      recommendation: z.string().max(2000).default(""),
      immediateAction: z.string().max(2000).default(""),
      followUpRequired: z.boolean().default(false),
    })
    .optional(),
});

/**
 * Legacy/direct occurrence lifecycle (PM §25/§74/§75).
 * Occurrences WITH an execution work order (all new ones) are executed through
 * the canonical Work Order transition API — this endpoint returns a pointer in
 * that case so there is exactly one state machine. Unlinked (historical) tasks
 * keep completing here. `fail` records a mandatory finding and closes the
 * occurrence as FAILED without advancing the schedule (§75).
 */
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
        workOrder: { select: { id: true, code: true, status: true } },
      },
    });
    if (!task) throw Errors.notFound("PM task not found.");

    // §22/§25 — one state machine: linked occurrences are driven by the Work Order API.
    if (task.workOrderId && body.action !== "fail") {
      return ok(
        {
          useWorkOrderApi: true,
          workOrderId: task.workOrderId,
          workOrderCode: task.workOrder?.code,
          message: `This occurrence is executed through work order ${task.workOrder?.code}. Use POST /api/v1/work-orders/${task.workOrderId}/transition.`,
        },
        200
      );
    }

    const canManage = roleCan(user.role, PERMISSIONS.pm_manage);
    const canExecute = roleCan(user.role, PERMISSIONS.pm_execute);
    const isAssigned = task.technician?.userId === user.id;

    // Optionally persist checklist toggles supplied alongside the transition (legacy tasks)
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

      // §18 — backend-authoritative checklist guard (missing items → list returned).
      const items = await db.pmTaskChecklistItem.findMany({ where: { taskId: id } });
      const pending = items.filter((i) => !i.done);
      if (pending.length > 0 && !(body.force && canManage)) {
        throw Errors.invalidTransition(
          `Cannot complete: ${pending.length} required checklist item(s) missing (${pending.slice(0, 5).map((i) => i.label).join(", ")}${pending.length > 5 ? "…" : ""}).`
        );
      }

      const now = new Date();
      const updated = await db.$transaction(async (tx) => {
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

    // §75 — PM FAILED: equipment unsafe/defective. Requires the recorded result.
    if (body.action === "fail") {
      if (!canExecute && !canManage && !isAssigned) throw Errors.forbidden("Only the assigned technician can fail this task.");
      if (!["SCHEDULED", "OVERDUE", "IN_PROGRESS"].includes(task.status)) {
        throw Errors.invalidTransition(`Cannot fail a task in status ${task.status}.`);
      }
      if (!body.finding) throw Errors.invalidTransition("A finding is required to mark a PM as failed — record what is wrong with the equipment.");

      const now = new Date();
      const updated = await db.$transaction(async (tx) => {
        const failure = await tx.pmTask.update({
          where: { id },
          data: { status: "FAILED", failedAt: now, failureReason: body.finding?.title ?? "", notes: body.notes ?? task.notes },
        });
        await tx.pmFinding.create({
          data: {
            pmTaskId: task.id,
            planId: task.planId,
            equipmentId: task.equipmentId,
            workOrderId: task.workOrderId,
            title: body.finding?.title ?? "PM failed",
            description: body.finding?.description ?? "",
            severity: body.finding?.severity ?? "MEDIUM",
            cause: body.finding?.cause ?? "",
            recommendation: body.finding?.recommendation ?? "",
            immediateAction: body.finding?.immediateAction ?? "",
            followUpRequired: body.finding?.followUpRequired ?? true,
            createdById: user.id,
          },
        });
        // The inspection work itself happened — close a linked execution work
        // order that was already started; one that never started is cancelled
        // (it will never be executed — the occurrence is FAILED, PM §75).
        if (task.workOrderId && task.workOrder?.status === "IN_PROGRESS") {
          await recalcWorkOrderTotals(task.workOrderId);
          const wo = await tx.workOrder.update({
            where: { id: task.workOrderId },
            data: { status: "COMPLETED", completedAt: now, notes: `PM failed: ${body.finding?.title ?? ""}` },
          });
          await tx.pmTask.update({ where: { id }, data: { workOrderId: wo.id } });
        } else if (task.workOrderId && ["PENDING", "ACCEPTED"].includes(task.workOrder?.status ?? "")) {
          await tx.workOrder.update({
            where: { id: task.workOrderId },
            data: { status: "CANCELLED", notes: `PM failed before start: ${body.finding?.title ?? ""}` },
          });
        }
        return failure;
      });

      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PM_FAILED",
        resourceType: "PmTask",
        resourceId: id,
        metadata: { code: task.code, severity: body.finding?.severity, reason: body.finding?.title },
      });
      await notifyRole("SUPERVISOR", {
        title: "PM failed",
        message: `${task.code} — ${task.plan.name} on ${task.equipment.name} could not be completed: ${body.finding?.title}. Corrective action required.`,
        type: "ERROR",
        resourceType: "PmTask",
        resourceId: id,
      });
      if (task.technician?.userId && task.technician.userId !== user.id) {
        await notify({ userId: task.technician.userId, title: "PM marked failed", message: `${task.code} was marked failed.`, type: "WARNING", resourceType: "PmTask", resourceId: id });
      }
      return ok(updated);
    }

    // action === "skip" (§74 — supervisor decision, audited; occurrence is never counted)
    if (!canManage) throw Errors.forbidden("Only supervisors can skip PM tasks.");
    if (["COMPLETED", "SKIPPED"].includes(task.status)) {
      throw Errors.invalidTransition(`Task is already ${task.status.toLowerCase()}.`);
    }
    const skipped = await db.$transaction(async (tx) => {
      const row = await tx.pmTask.update({
        where: { id },
        data: { status: "SKIPPED", notes: body.notes ?? task.notes },
      });
      // §74 — skipping the occurrence cancels its execution work order.
      if (task.workOrderId && task.workOrder && !["COMPLETED", "CANCELLED"].includes(task.workOrder.status)) {
        await tx.workOrder.update({ where: { id: task.workOrderId }, data: { status: "CANCELLED" } });
      }
      return row;
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
