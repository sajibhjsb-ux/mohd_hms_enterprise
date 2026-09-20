import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS, PM_FREQUENCIES, PM_PLAN_TYPES, PM_PRIORITIES, type Permission } from "@/lib/hms/constants";
import { isMeterPlanType, parseChecklistTemplate, serializeChecklistTemplate } from "@/lib/hms/pm/schedule";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const planInclude = {
  equipment: {
    select: {
      id: true, name: true, assetTag: true, criticality: true, category: true, model: true, manufacturer: true,
      warrantyExpiry: true, status: true,
      customer: { select: { id: true, companyName: true, code: true } },
      location: { select: { id: true, name: true } },
    },
  },
  assignedTechnician: { select: { id: true, employeeNo: true, specialty: true, user: { select: { id: true, name: true } } } },
  meter: { select: { id: true, name: true, unit: true, currentReading: true, currentReadingAt: true } },
  template: { select: { id: true, name: true } },
} as const;

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission: Permission) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

/** §51 — full plan detail: overview, occurrence history, findings, costs, documents, audit trail. */
export const GET = withId(
  async (id) => {
    const plan = await db.pmPlan.findUnique({ where: { id }, include: planInclude });
    if (!plan) throw Errors.notFound("PM plan not found.");

    const [tasks, findings, documents] = await Promise.all([
      db.pmTask.findMany({
        where: { planId: plan.id },
        orderBy: { dueDate: "desc" },
        take: 50,
        select: {
          id: true, code: true, dueDate: true, status: true, priority: true, completedAt: true, occurrenceKey: true,
          failureReason: true, rescheduleReason: true,
          technician: { select: { user: { select: { name: true } } } },
          workOrder: { select: { id: true, code: true, status: true, totalCents: true, labourTotalCents: true, materialsTotalCents: true } },
        },
      }),
      db.pmFinding.findMany({
        where: { planId: plan.id },
        orderBy: { createdAt: "desc" },
        take: 25,
        include: {
          equipment: { select: { id: true, name: true, assetTag: true } },
          correctiveWorkOrder: { select: { id: true, code: true, status: true } },
          pmTask: { select: { id: true, code: true } },
        },
      }),
      db.document.findMany({
        where: { resourceType: "PM_PLAN", resourceId: id },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true, label: true, uploadedById: true },
      }),
    ]);

    // §51/§72 — plan audit trail includes occurrence-level actions.
    const taskIds = tasks.map((t) => t.id);
    const auditLogs = await db.auditLog.findMany({
      where: {
        OR: [
          { resourceType: "PmPlan", resourceId: id },
          ...(taskIds.length > 0 ? [{ resourceType: "PM_TASK", resourceId: { in: taskIds } }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    });

    // Costs (§41) — aggregated from the occurrence work orders (backend-authoritative NUMERIC-free ints in cents).
    const completedTasks = tasks.filter((t) => t.workOrder);
    const costs = completedTasks.reduce(
      (acc, t) => ({
        labourCents: acc.labourCents + (t.workOrder?.labourTotalCents ?? 0),
        materialsCents: acc.materialsCents + (t.workOrder?.materialsTotalCents ?? 0),
        totalCents: acc.totalCents + (t.workOrder?.totalCents ?? 0),
      }),
      { labourCents: 0, materialsCents: 0, totalCents: 0 }
    );

    return ok({
      ...plan,
      checklistItems: parseChecklistTemplate(plan.checklistTemplate),
      requiredParts: JSON.parse(plan.requiredParts || "[]"),
      tasks,
      findings,
      auditLogs,
      documents,
      costs,
    });
  },
  PERMISSIONS.pm_read
);

const checklistItemSchema = z.object({
  label: z.string().min(1).max(300),
  required: z.boolean().default(false),
  responseType: z.enum(["CHECKBOX", "PASSFAIL", "YESNO", "NUMERIC", "TEXT"]).default("CHECKBOX"),
});

const requiredPartSchema = z.object({
  inventoryItemId: z.string().nullish(),
  name: z.string().min(1).max(200),
  quantity: z.number().positive(),
  unit: z.string().default("pcs"),
});

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().max(4000).optional(),
  planType: z.enum(PM_PLAN_TYPES).optional(),
  frequency: z.enum(PM_FREQUENCIES).optional(),
  customIntervalDays: z.number().int().positive().max(3650).nullish(),
  intervalUnits: z.number().int().positive().max(365).nullish(),
  intervalUnit: z.enum(["DAYS", "WEEKS", "MONTHS", "YEARS"]).nullish(),
  monthlyOccurrence: z.enum(["FIRST", "SECOND", "THIRD", "FOURTH", "LAST"]).nullish(),
  monthlyWeekday: z.number().int().min(0).max(6).nullish(),
  priority: z.enum(PM_PRIORITIES).optional(),
  assignedTechnicianId: z.string().min(1).nullish(),
  checklistTemplate: z.array(z.union([z.string().min(1), checklistItemSchema])).optional(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  estimatedMinutes: z.number().int().min(5).max(1440).optional(),
  requiredSkills: z.string().max(1000).optional(),
  safetyRequirements: z.string().max(4000).optional(),
  instructions: z.string().max(8000).optional(),
  requiredParts: z.array(requiredPartSchema).optional(),
  meterId: z.string().nullish(),
  meterInterval: z.number().positive().nullish(),
  slaResponseHours: z.number().int().min(1).max(8760).nullish(),
  slaCompletionHours: z.number().int().min(1).max(8760).nullish(),
  nextDueDate: z.string().nullish(),
  active: z.boolean().optional(),
});

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);

    const plan = await db.pmPlan.findUnique({ where: { id }, include: { meter: true } });
    if (!plan) throw Errors.notFound("PM plan not found.");

    if (body.assignedTechnicianId) {
      const tech = await db.technicianProfile.findUnique({ where: { id: body.assignedTechnicianId } });
      if (!tech) throw Errors.badRequest("Assigned technician does not exist.");
    }
    if (body.meterId) {
      const meter = await db.equipmentMeter.findUnique({ where: { id: body.meterId } });
      if (!meter || meter.equipmentId !== plan.equipmentId) throw Errors.badRequest("Selected meter does not belong to the plan's equipment.");
    }

    let nextDue: Date | undefined;
    if (body.nextDueDate !== undefined && body.nextDueDate !== null) {
      const d = new Date(body.nextDueDate);
      if (isNaN(d.getTime())) throw Errors.badRequest("Next due date is invalid.");
      nextDue = d;
    }

    const effectiveType = body.planType ?? plan.planType;
    const meterType = isMeterPlanType(effectiveType);

    // §52 — changes are audited; historical completed occurrences are never rewritten.
    const updated = await db.pmPlan.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.planType !== undefined ? { planType: body.planType } : {}),
        ...(body.frequency !== undefined ? { frequency: body.frequency } : {}),
        ...(body.customIntervalDays !== undefined ? { customIntervalDays: body.customIntervalDays ?? null } : {}),
        ...(body.intervalUnits !== undefined ? { intervalUnits: body.intervalUnits ?? null } : {}),
        ...(body.intervalUnit !== undefined ? { intervalUnit: body.intervalUnit ?? null } : {}),
        ...(body.monthlyOccurrence !== undefined ? { monthlyOccurrence: body.monthlyOccurrence ?? null } : {}),
        ...(body.monthlyWeekday !== undefined ? { monthlyWeekday: body.monthlyWeekday ?? null } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.assignedTechnicianId !== undefined ? { assignedTechnicianId: body.assignedTechnicianId ?? null } : {}),
        ...(body.checklistTemplate !== undefined
          ? {
              checklistTemplate: serializeChecklistTemplate(
                parseChecklistTemplate(serializeChecklistTemplate(
                  body.checklistTemplate.map((raw) => (typeof raw === "string" ? { label: raw, required: false, responseType: "CHECKBOX" } : raw))
                ))
              ),
            }
          : {}),
        ...(body.startDate !== undefined ? { startDate: body.startDate ? new Date(body.startDate) : null } : {}),
        ...(body.endDate !== undefined ? { endDate: body.endDate ? new Date(body.endDate) : null } : {}),
        ...(body.estimatedMinutes !== undefined ? { estimatedMinutes: body.estimatedMinutes } : {}),
        ...(body.requiredSkills !== undefined ? { requiredSkills: body.requiredSkills } : {}),
        ...(body.safetyRequirements !== undefined ? { safetyRequirements: body.safetyRequirements } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.requiredParts !== undefined ? { requiredParts: JSON.stringify(body.requiredParts) } : {}),
        ...(meterType
          ? {
              ...(body.meterId !== undefined ? { meterId: body.meterId ?? null } : {}),
              ...(body.meterInterval !== undefined ? { meterInterval: body.meterInterval ?? null } : {}),
            }
          : {}),
        ...(body.slaResponseHours !== undefined ? { slaResponseHours: body.slaResponseHours ?? null } : {}),
        ...(body.slaCompletionHours !== undefined ? { slaCompletionHours: body.slaCompletionHours ?? null } : {}),
        ...(body.nextDueDate !== undefined ? { nextDueDate: nextDue ?? null } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      include: planInclude,
    });

    // §72 — activation carries an approval record (separate action for audit clarity).
    if (body.active === true && !plan.active) {
      await db.pmPlan.update({ where: { id }, data: { approvedById: user.id, approvedAt: new Date() } });
      await audit({ actorId: user.id, actorEmail: user.email, action: "PM_PLAN_ACTIVATED", resourceType: "PmPlan", resourceId: id, metadata: { code: plan.code } });
    }
    if (body.active === false && plan.active) {
      await audit({ actorId: user.id, actorEmail: user.email, action: "PM_PLAN_DEACTIVATED", resourceType: "PmPlan", resourceId: id, metadata: { code: plan.code } });
    }

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_PLAN_UPDATED",
      resourceType: "PmPlan",
      resourceId: id,
      metadata: { code: plan.code, fields: Object.keys(body) },
    });
    await emit({ type: EVENT_TYPES.PM_PLAN_UPDATED, resourceType: "PmPlan", resourceId: id, payload: { code: plan.code, action: "UPDATED" }, actorType: "USER", actorId: user.id });

    return ok(updated);
  },
  PERMISSIONS.pm_manage
);

/** Soft delete: plans keep task history — deactivate instead of removing rows (§72 audited). */
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
