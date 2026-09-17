import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS, FREQUENCY_DAYS, PM_FREQUENCIES, type Permission } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

const planInclude = {
  equipment: { select: { id: true, name: true, assetTag: true } },
  assignedTechnician: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
} as const;

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission: Permission) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const GET = withId(
  async (id) => {
    const plan = await db.pmPlan.findUnique({ where: { id }, include: planInclude });
    if (!plan) throw Errors.notFound("PM plan not found.");
    const recentTasks = await db.pmTask.findMany({
      where: { planId: plan.id },
      orderBy: { dueDate: "desc" },
      take: 10,
      select: { id: true, code: true, dueDate: true, status: true, completedAt: true, technician: { select: { user: { select: { name: true } } } } },
    });
    return ok({ ...plan, recentTasks });
  },
  PERMISSIONS.pm_read
);

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  frequency: z.enum(PM_FREQUENCIES).optional(),
  assignedTechnicianId: z.string().min(1).nullish(),
  checklistTemplate: z.array(z.string().min(1)).optional(),
  nextDueDate: z.string().nullish(),
  active: z.boolean().optional(),
});

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);

    const plan = await db.pmPlan.findUnique({ where: { id } });
    if (!plan) throw Errors.notFound("PM plan not found.");

    if (body.assignedTechnicianId) {
      const tech = await db.technicianProfile.findUnique({ where: { id: body.assignedTechnicianId } });
      if (!tech) throw Errors.badRequest("Assigned technician does not exist.");
    }
    let nextDue: Date | undefined;
    if (body.nextDueDate !== undefined && body.nextDueDate !== null) {
      const d = new Date(body.nextDueDate);
      if (isNaN(d.getTime())) throw Errors.badRequest("Next due date is invalid.");
      nextDue = d;
    }
    if (body.frequency && body.frequency !== plan.frequency && body.nextDueDate === undefined) {
      // Keep cadence sensible: re-baseline next due from today when frequency changes
      nextDue = new Date(Date.now() + (FREQUENCY_DAYS[body.frequency] ?? 30) * 86400000);
    }

    const updated = await db.pmPlan.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.frequency !== undefined ? { frequency: body.frequency } : {}),
        ...(body.assignedTechnicianId !== undefined ? { assignedTechnicianId: body.assignedTechnicianId ?? null } : {}),
        ...(body.checklistTemplate !== undefined
          ? { checklistTemplate: JSON.stringify(body.checklistTemplate.filter((l) => l.trim().length > 0)) }
          : {}),
        ...(body.nextDueDate !== undefined ? { nextDueDate: nextDue ?? null } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      include: planInclude,
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_PLAN_UPDATED",
      resourceType: "PmPlan",
      resourceId: id,
      metadata: { code: plan.code, fields: Object.keys(body) },
    });

    return ok(updated);
  },
  PERMISSIONS.pm_manage
);

/** Soft delete: plans keep task history — deactivate instead of removing rows. */
export const DELETE = withId(
  async (id, { req, user }) => {
    const plan = await db.pmPlan.findUnique({ where: { id } });
    if (!plan) throw Errors.notFound("PM plan not found.");
    if (!plan.active) throw Errors.invalidTransition("PM plan is already inactive.");

    const updated = await db.pmPlan.update({ where: { id }, data: { active: false }, include: planInclude });
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_PLAN_DEACTIVATED",
      resourceType: "PmPlan",
      resourceId: id,
      metadata: { code: plan.code },
    });
    return ok(updated);
  },
  PERMISSIONS.pm_manage
);
