import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS, FREQUENCY_DAYS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit, nextNumber, notify } from "@/lib/hms/services";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c))(req);
  };
}

/**
 * Generate a scheduled PM task from a plan.
 * Allowed for pm_manage (supervisors) OR pm_execute (technicians may self-generate).
 * Creates the task + checklist items from the plan template and advances the
 * plan's nextDueDate by its frequency so the cycle always stays ahead.
 */
export const POST = withId(
  async (id, { req, user }) => {
    const allowed = roleCan(user.role, PERMISSIONS.pm_manage) || roleCan(user.role, PERMISSIONS.pm_execute);
    if (!allowed) throw Errors.forbidden();

    const plan = await db.pmPlan.findUnique({
      where: { id },
      include: { equipment: true, assignedTechnician: { include: { user: true } } },
    });
    if (!plan) throw Errors.notFound("PM plan not found.");
    if (!plan.active) throw Errors.invalidTransition("PM plan is inactive. Activate it before generating tasks.");

    // Template → checklist item labels
    let labels: string[] = [];
    try {
      const parsed: unknown = JSON.parse(plan.checklistTemplate || "[]");
      if (Array.isArray(parsed)) labels = parsed.filter((l): l is string => typeof l === "string" && l.trim().length > 0);
    } catch {
      labels = [];
    }

    const code = await nextNumber("PMT");
    const dueDate = plan.nextDueDate ?? new Date();
    const nextDue = new Date(dueDate.getTime() + (FREQUENCY_DAYS[plan.frequency] ?? 30) * 86400000);

    const task = await db.$transaction(async (tx) => {
      const created = await tx.pmTask.create({
        data: {
          code,
          planId: plan.id,
          equipmentId: plan.equipmentId,
          technicianId: plan.assignedTechnicianId ?? null,
          dueDate,
          status: "SCHEDULED",
        },
      });
      if (labels.length > 0) {
        await tx.pmTaskChecklistItem.createMany({
          data: labels.map((label, i) => ({ taskId: created.id, label, done: false, sortOrder: i })),
        });
      }
      await tx.pmPlan.update({ where: { id: plan.id }, data: { nextDueDate: nextDue } });
      return created;
    });

    const full = await db.pmTask.findUnique({
      where: { id: task.id },
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
      action: "PM_TASK_GENERATED",
      resourceType: "PmTask",
      resourceId: task.id,
      metadata: { code, planCode: plan.code, equipment: plan.equipment.name },
    });

    if (plan.assignedTechnician) {
      await notify({
        userId: plan.assignedTechnician.userId,
        title: "PM task scheduled",
        message: `${code} — ${plan.name} on ${plan.equipment.name} is due ${dueDate.toISOString().slice(0, 10)}.`,
        type: "INFO",
        resourceType: "PmTask",
        resourceId: task.id,
      });
    }

    return ok(full, 201);
  }
);
