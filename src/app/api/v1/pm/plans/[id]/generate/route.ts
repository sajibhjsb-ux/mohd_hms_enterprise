import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { generatePmOccurrence, PmGenerateError } from "@/lib/hms/pm/generate";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c))(req);
  };
}

const generateSchema = z.object({
  dueDate: z.string().datetime().optional(),
});

/**
 * Generate the next scheduled PM occurrence from a plan (PM §22/§23).
 * Allowed for pm_manage (supervisors) OR pm_execute (technicians may self-generate).
 * Idempotent: the same occurrence (planId + occurrenceKey) never produces two
 * tasks/work orders — repeated calls return the existing open occurrence.
 * Creates the PmTask occurrence + its execution Work Order (sourceType=PM) with
 * the checklist snapshot, and advances the plan's next due (calendar or meter).
 */
export const POST = withId(
  async (id, { req, user }) => {
    const allowed = roleCan(user.role, PERMISSIONS.pm_manage) || roleCan(user.role, PERMISSIONS.pm_execute);
    if (!allowed) throw Errors.forbidden();

    const body = await parseBody(req, generateSchema).catch(() => ({}) as { dueDate?: string });
    const dueDate = body?.dueDate ? new Date(body.dueDate) : undefined;
    if (dueDate && Number.isNaN(dueDate.getTime())) throw Errors.badRequest("dueDate must be a valid ISO date.");

    let result: Awaited<ReturnType<typeof generatePmOccurrence>>;
    try {
      result = await generatePmOccurrence({
        planId: id,
        actorId: user.id,
        actorEmail: user.email,
        dueDate,
        source: "MANUAL",
      });
    } catch (err) {
      if (err instanceof PmGenerateError) {
        if (err.code === "NOT_FOUND") throw Errors.notFound(err.message);
        throw Errors.invalidTransition(err.message);
      }
      throw err;
    }

    if (!result.created) {
      // Idempotent success — the occurrence already exists; surface it so the
      // UI can navigate there instead of duplicating work (PM §61).
      return ok({ duplicate: true, reason: result.reason, taskId: result.existingTaskId ?? null, taskCode: result.existingTaskCode ?? null });
    }

    const full = await db.pmTask.findUnique({
      where: { id: result.taskId },
      include: {
        plan: { select: { id: true, name: true, code: true, planType: true, priority: true } },
        equipment: { select: { id: true, name: true, assetTag: true, criticality: true } },
        technician: { select: { id: true, user: { select: { name: true } } } },
        checklist: { orderBy: { sortOrder: "asc" } },
        workOrder: {
          select: {
            id: true, code: true, status: true, priority: true,
            checklist: { orderBy: { sortOrder: "asc" } },
          },
        },
      },
    });

    return ok({ duplicate: false, task: full, workOrderId: result.workOrderId, workOrderCode: result.workOrderCode, nextDueDate: result.nextDueDate, nextDueMeter: result.nextDueMeter }, 201);
  }
);
