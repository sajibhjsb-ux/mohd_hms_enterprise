// MOHD.HMS ENTERPRISE — meter readings (PM §10/§62).
// POST /api/v1/pm/meter-readings — record a reading; readings may never move
// backwards unless a manager records an explicit correction (§10). When a
// reading crosses a meter-based plan's service threshold, PM_DUE is raised
// through the event outbox (§62 — event-driven, no polling shortcuts).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, PM_METER_PLAN_TYPES } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const OPEN_TASK_STATUSES = ["SCHEDULED", "OVERDUE", "IN_PROGRESS"];

const readingSchema = z.object({
  meterId: z.string().min(1, "Meter is required."),
  reading: z.number().positive("Reading must be greater than zero."),
  readingDate: z.string().optional(),
  notes: z.string().max(1000).optional(),
  isCorrection: z.boolean().default(false),
});

export const POST = handler(
  async ({ req, user }) => {
    // Layered permission (§41): handler gate is pm_read; recording needs
    // pm_execute (technicians) or pm_manage (supervisors/admins).
    const allowed = roleCan(user.role, PERMISSIONS.pm_execute) || roleCan(user.role, PERMISSIONS.pm_manage);
    if (!allowed) throw Errors.forbidden();

    const body = await parseBody(req, readingSchema);
    const meter = await db.equipmentMeter.findUnique({ where: { id: body.meterId } });
    if (!meter) throw Errors.notFound("Meter not found.");

    // §10 — monotonic meter: backwards readings only as a manager correction.
    if (body.reading < meter.currentReading) {
      const canCorrect = roleCan(user.role, PERMISSIONS.pm_manage) && body.isCorrection;
      if (!canCorrect) {
        throw Errors.invalidTransition(`Reading cannot move backwards (${meter.currentReading} → ${body.reading}). Corrections require a manager.`);
      }
    }

    const readingDate = body.readingDate ? new Date(body.readingDate) : new Date();
    if (Number.isNaN(readingDate.getTime())) throw Errors.badRequest("readingDate must be a valid ISO date.");

    const { created, updated } = await db.$transaction(async (tx) => {
      const created = await tx.equipmentMeterReading.create({
        data: {
          meterId: meter.id,
          reading: body.reading,
          readingDate,
          recordedById: user.id,
          source: "MANUAL",
          notes: body.notes ?? "",
        },
      });
      const updated = await tx.equipmentMeter.update({
        where: { id: meter.id },
        data: { currentReading: body.reading, currentReadingAt: readingDate },
      });
      return { created, updated };
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_METER_READING_RECORDED",
      resourceType: "EQUIPMENT_METER",
      resourceId: meter.id,
      metadata: {
        equipmentId: meter.equipmentId,
        meterName: meter.name,
        reading: body.reading,
        previousReading: meter.currentReading,
        isCorrection: body.isCorrection,
      },
    });

    // §62 — event-driven meter PM: crossing a plan's threshold raises PM_DUE.
    const triggeredPlans: { planId: string; code: string }[] = [];
    const plans = await db.pmPlan.findMany({
      where: { meterId: meter.id, active: true, planType: { in: PM_METER_PLAN_TYPES } },
      select: { id: true, code: true, meterInterval: true, nextDueMeter: true },
    });
    for (const plan of plans) {
      const threshold = plan.nextDueMeter ?? plan.meterInterval;
      if (!threshold || body.reading < threshold) continue;
      const open = await db.pmTask.findFirst({
        where: { planId: plan.id, status: { in: OPEN_TASK_STATUSES } },
        select: { id: true },
      });
      if (open) continue;
      await emit({
        type: EVENT_TYPES.PM_DUE,
        resourceType: "PM_PLAN",
        resourceId: plan.id,
        payload: { planId: plan.id },
        actorType: "USER",
        actorId: user.id,
      });
      triggeredPlans.push({ planId: plan.id, code: plan.code });
    }

    return ok({ reading: created, meter: updated, triggeredPlans }, 201);
  },
  { permission: PERMISSIONS.pm_read }
);
