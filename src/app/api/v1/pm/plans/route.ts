import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS, PM_FREQUENCIES, PM_PLAN_TYPES, PM_PRIORITIES } from "@/lib/hms/constants";
import { endOfDay } from "date-fns";
import { isMeterPlanType, parseChecklistTemplate, serializeChecklistTemplate, priorityFromCriticality } from "@/lib/hms/pm/schedule";
import { audit, nextNumber } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const planInclude = {
  equipment: { select: { id: true, name: true, assetTag: true, criticality: true, category: true, customer: { select: { id: true, companyName: true } } } },
  assignedTechnician: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
  meter: { select: { id: true, name: true, unit: true, currentReading: true } },
  template: { select: { id: true, name: true } },
  _count: { select: { tasks: true } },
} as const;

export const GET = handler(
  async ({ req, user }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const active = (sp.get("active") ?? "").trim();
    const dueBefore = (sp.get("dueBefore") ?? "").trim();
    const planType = (sp.get("planType") ?? "").trim();
    const equipmentId = (sp.get("equipmentId") ?? "").trim();

    const where: Record<string, unknown> = {};
    // §44 — customers only ever see plans for their own equipment.
    if (user.role === "CUSTOMER") {
      where.equipment = { is: { customerId: user.customerId ?? "__none__" } };
    }
    if (active === "1") where.active = true;
    else if (active === "0") where.active = false;
    if (planType) where.planType = planType;
    if (equipmentId) where.equipmentId = equipmentId;
    if (q.search) {
      where.OR = [
        { code: { contains: q.search } },
        { name: { contains: q.search } },
        { equipment: { is: { name: { contains: q.search } } } },
        { equipment: { is: { assetTag: { contains: q.search } } } },
      ];
    }
    if (dueBefore) {
      const d = new Date(dueBefore);
      if (!isNaN(d.getTime())) where.nextDueDate = { lte: d };
    }

    const dir = q.dir === "asc" ? ("asc" as const) : ("desc" as const);
    const [items, total] = await Promise.all([
      db.pmPlan.findMany({
        where,
        include: planInclude,
        orderBy: q.sort === "name" ? { name: dir } : { createdAt: dir },
        skip: q.skip,
        take: q.take,
      }),
      db.pmPlan.count({ where }),
    ]);

    return okList(items, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.pm_read }
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

const createSchema = z.object({
  name: z.string().min(2, "Plan name is required."),
  description: z.string().max(4000).default(""),
  equipmentId: z.string().min(1, "Equipment is required."),
  planType: z.enum(PM_PLAN_TYPES).default("CALENDAR"),
  frequency: z.enum(PM_FREQUENCIES),
  customIntervalDays: z.number().int().positive().max(3650).nullish(),
  intervalUnits: z.number().int().positive().max(365).nullish(),
  intervalUnit: z.enum(["DAYS", "WEEKS", "MONTHS", "YEARS"]).nullish(),
  monthlyOccurrence: z.enum(["FIRST", "SECOND", "THIRD", "FOURTH", "LAST"]).nullish(),
  monthlyWeekday: z.number().int().min(0).max(6).nullish(),
  priority: z.enum(PM_PRIORITIES).optional(), // default: derived from equipment criticality (§34)
  assignedTechnicianId: z.string().min(1).nullish(),
  checklistTemplate: z.array(z.union([z.string().min(1), checklistItemSchema])).default([]),
  templateId: z.string().nullish(),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  estimatedMinutes: z.number().int().min(5).max(1440).default(60),
  requiredSkills: z.string().max(1000).default(""),
  safetyRequirements: z.string().max(4000).default(""),
  instructions: z.string().max(8000).default(""),
  requiredParts: z.array(requiredPartSchema).default([]),
  meterId: z.string().nullish(),
  meterInterval: z.number().positive().nullish(),
  slaResponseHours: z.number().int().min(1).max(8760).nullish(),
  slaCompletionHours: z.number().int().min(1).max(8760).nullish(),
  nextDueDate: z.string().nullish(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    const equipment = await db.equipment.findUnique({ where: { id: body.equipmentId } });
    if (!equipment) throw Errors.badRequest("Selected equipment does not exist.");
    if (body.assignedTechnicianId) {
      const tech = await db.technicianProfile.findUnique({ where: { id: body.assignedTechnicianId } });
      if (!tech) throw Errors.badRequest("Assigned technician does not exist.");
    }
    const meterType = isMeterPlanType(body.planType);
    if (meterType) {
      if (!body.meterId) throw Errors.badRequest("Meter-based plans require a linked equipment meter.");
      const meter = await db.equipmentMeter.findUnique({ where: { id: body.meterId } });
      if (!meter || meter.equipmentId !== body.equipmentId) throw Errors.badRequest("Selected meter does not belong to the equipment.");
      if (!body.meterInterval || body.meterInterval <= 0) throw Errors.badRequest("Meter-based plans require a service interval.");
    } else {
      if (body.frequency === "CUSTOM" && (!body.customIntervalDays || body.customIntervalDays <= 0)) {
        throw Errors.badRequest("Custom frequency requires a positive interval in days.");
      }
      if (body.monthlyOccurrence && (body.monthlyWeekday === null || body.monthlyWeekday === undefined)) {
        throw Errors.badRequest("Advanced monthly recurrence requires a weekday.");
      }
    }

    // Next due: explicit date, or derived from the start date/frequency.
    let nextDue: Date;
    if (body.nextDueDate) {
      const d = new Date(body.nextDueDate);
      if (isNaN(d.getTime())) throw Errors.badRequest("Next due date is invalid.");
      nextDue = d;
    } else {
      const start = body.startDate ? new Date(body.startDate) : new Date();
      nextDue = endOfDay(start);
    }
    if (meterType) {
      // First meter cycle due at current reading + interval.
      const meter = await db.equipmentMeter.findUnique({ where: { id: body.meterId as string } });
      const base = meter?.currentReading ?? 0;
      nextDueMeter = base + (body.meterInterval as number);
    }

    const items = parseChecklistTemplate(serializeChecklistTemplate(
      body.checklistTemplate.map((raw) => (typeof raw === "string" ? { label: raw, required: false, responseType: "CHECKBOX" } : raw))
    ));
    let nextDueMeter: number | null = null;

    const code = await nextNumber("PM");
    const plan = await db.pmPlan.create({
      data: {
        code,
        name: body.name,
        description: body.description,
        equipmentId: body.equipmentId,
        planType: body.planType,
        frequency: body.frequency,
        customIntervalDays: body.customIntervalDays ?? null,
        intervalUnits: body.intervalUnits ?? null,
        intervalUnit: body.intervalUnit ?? null,
        monthlyOccurrence: body.monthlyOccurrence ?? null,
        monthlyWeekday: body.monthlyWeekday ?? null,
        priority: body.priority ?? priorityFromCriticality(equipment.criticality),
        assignedTechnicianId: body.assignedTechnicianId ?? null,
        checklistTemplate: serializeChecklistTemplate(items),
        templateId: body.templateId ?? null,
        startDate: body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate ? new Date(body.endDate) : null,
        estimatedMinutes: body.estimatedMinutes,
        requiredSkills: body.requiredSkills,
        safetyRequirements: body.safetyRequirements,
        instructions: body.instructions,
        requiredParts: JSON.stringify(body.requiredParts),
        meterId: meterType ? body.meterId ?? null : null,
        meterInterval: meterType ? body.meterInterval ?? null : null,
        nextDueMeter,
        slaResponseHours: body.slaResponseHours ?? null,
        slaCompletionHours: body.slaCompletionHours ?? null,
        active: true,
        nextDueDate: meterType ? null : nextDue,
      },
      include: planInclude,
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_PLAN_CREATED",
      resourceType: "PmPlan",
      resourceId: plan.id,
      metadata: { code, name: plan.name, frequency: plan.frequency, planType: plan.planType, priority: plan.priority },
    });

    // Realtime: PM views update live.
    await emit({ type: EVENT_TYPES.PM_PLAN_UPDATED, resourceType: "PmPlan", resourceId: plan.id, payload: { code, action: "CREATED" }, actorType: "USER", actorId: user.id });
    return ok(plan, 201);
  },
  { permission: PERMISSIONS.pm_manage }
);
