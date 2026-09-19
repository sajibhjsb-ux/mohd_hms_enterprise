import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS, FREQUENCY_DAYS, PM_FREQUENCIES } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const planInclude = {
  equipment: { select: { id: true, name: true, assetTag: true } },
  assignedTechnician: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
} as const;

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const active = (sp.get("active") ?? "").trim();
    const dueBefore = (sp.get("dueBefore") ?? "").trim();

    const where: Record<string, unknown> = {};
    if (active === "1") where.active = true;
    else if (active === "0") where.active = false;
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

const createSchema = z.object({
  name: z.string().min(2, "Plan name is required."),
  equipmentId: z.string().min(1, "Equipment is required."),
  frequency: z.enum(PM_FREQUENCIES),
  assignedTechnicianId: z.string().min(1).nullish(),
  checklistTemplate: z.array(z.string().min(1)).default([]),
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

    const days = FREQUENCY_DAYS[body.frequency] ?? 30;
    let nextDue = new Date(Date.now() + days * 86400000);
    if (body.nextDueDate) {
      const d = new Date(body.nextDueDate);
      if (isNaN(d.getTime())) throw Errors.badRequest("Next due date is invalid.");
      nextDue = d;
    }

    const code = await nextNumber("PM");
    const plan = await db.pmPlan.create({
      data: {
        code,
        name: body.name,
        equipmentId: body.equipmentId,
        frequency: body.frequency,
        assignedTechnicianId: body.assignedTechnicianId ?? null,
        checklistTemplate: JSON.stringify(body.checklistTemplate.filter((l) => l.trim().length > 0)),
        active: true,
        nextDueDate: nextDue,
      },
      include: planInclude,
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_PLAN_CREATED",
      resourceType: "PmPlan",
      resourceId: plan.id,
      metadata: { code, name: plan.name, frequency: plan.frequency },
    });

    // Realtime: PM views update live.
    await emit({ type: EVENT_TYPES.PM_PLAN_UPDATED, resourceType: "PmPlan", resourceId: plan.id, payload: { code, action: "CREATED" }, actorType: "USER", actorId: user.id });
    return ok(plan, 201);
  },
  { permission: PERMISSIONS.pm_manage }
);
