import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

/** §26/§51/§53 — occurrence detail incl. execution work order, photos and findings. */
export const GET = withId(
  async (id, { user }) => {
    const task = await db.pmTask.findUnique({
      where: { id },
      include: {
        plan: {
          select: {
            id: true, name: true, code: true, frequency: true, planType: true, priority: true, checklistTemplate: true,
            instructions: true, safetyRequirements: true, requiredSkills: true, estimatedMinutes: true,
            requiredParts: true, slaResponseHours: true, slaCompletionHours: true, meterInterval: true,
            meter: { select: { id: true, name: true, unit: true, currentReading: true } },
          },
        },
        equipment: {
          select: {
            id: true, name: true, assetTag: true, criticality: true, model: true, manufacturer: true, serialNumber: true,
            customerId: true, customer: { select: { id: true, companyName: true } },
            location: { select: { id: true, name: true } },
            meters: { select: { id: true, name: true, unit: true, currentReading: true } },
          },
        },
        technician: { select: { id: true, employeeNo: true, user: { select: { id: true, name: true } } } },
        checklist: { orderBy: { sortOrder: "asc" } },
        workOrder: {
          select: {
            id: true, code: true, status: true, priority: true, description: true, scheduledDate: true, startedAt: true, completedAt: true,
            labourHours: true, labourRateCents: true, labourTotalCents: true, materialsTotalCents: true, totalCents: true, notes: true,
            checklist: { orderBy: { sortOrder: "asc" } },
            materials: { orderBy: { id: "asc" }, include: { inventoryItem: { select: { id: true, name: true, unit: true } } } },
          },
        },
        findings: {
          orderBy: { createdAt: "desc" },
          include: { correctiveWorkOrder: { select: { id: true, code: true, status: true } } },
        },
      },
    });
    if (!task) throw Errors.notFound("PM task not found.");

    // §44 — customers may only view PM for their own equipment, and never see
    // internal cost/labour/notes data.
    if (user.role === "CUSTOMER") {
      if (task.equipment.customerId !== user.customerId) throw Errors.forbidden();
    }

    // Keep overdue state fresh on detail view too (§32) — a task due today is
    // not overdue until the day has passed.
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    if (task.status === "SCHEDULED" && task.dueDate.getTime() < todayStart.getTime()) {
      await db.pmTask.update({ where: { id: task.id }, data: { status: "OVERDUE" } }).catch(() => undefined);
      task.status = "OVERDUE";
    }

    const photos = await db.document.findMany({
      where: { resourceType: "PM_TASK", resourceId: task.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, mimeType: true, sizeBytes: true, label: true, createdAt: true, storagePath: true },
    });

    const isCustomer = user.role === "CUSTOMER";
    const planParts = task.plan.requiredParts ? JSON.parse(task.plan.requiredParts || "[]") : [];
    const body = {
      ...task,
      plan: {
        ...task.plan,
        // customers never see internal planning costs; requiredParts are part
        // identities only (§44)
        requiredParts: isCustomer ? planParts.map((p: { name: string; unit: string }) => ({ name: p.name, unit: p.unit })) : planParts,
      },
      photos,
      // §44 — hide internal work-order financials and technician notes from customers
      workOrder: task.workOrder && !isCustomer
        ? task.workOrder
        : task.workOrder
          ? {
              id: task.workOrder.id,
              code: task.workOrder.code,
              status: task.workOrder.status,
              priority: task.workOrder.priority,
              scheduledDate: task.workOrder.scheduledDate,
              completedAt: task.workOrder.completedAt,
              checklist: task.workOrder.checklist,
              description: task.workOrder.description,
              startedAt: task.workOrder.startedAt,
              labourHours: undefined,
              labourRateCents: undefined,
              labourTotalCents: undefined,
              materialsTotalCents: undefined,
              totalCents: undefined,
              notes: undefined,
              materials: [],
            }
          : null,
    };

    return ok(body);
  },
  PERMISSIONS.pm_read
);

const patchSchema = z.object({
  technicianId: z.string().min(1).nullish(),
  notes: z.string().max(2000).nullish(),
});

/** Reassign / annotate an occurrence (§52 — audited; never historical records). */
export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);

    const task = await db.pmTask.findUnique({ where: { id } });
    if (!task) throw Errors.notFound("PM task not found.");
    if (["COMPLETED", "SKIPPED", "CANCELLED", "FAILED"].includes(task.status)) {
      throw Errors.invalidTransition("Closed occurrences cannot be modified.");
    }
    if (body.technicianId) {
      const tech = await db.technicianProfile.findUnique({ where: { id: body.technicianId } });
      if (!tech) throw Errors.badRequest("Technician does not exist.");
    }

    const updated = await db.pmTask.update({
      where: { id },
      data: {
        ...(body.technicianId !== undefined ? { technicianId: body.technicianId ?? null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes ?? "" } : {}),
      },
      include: {
        plan: { select: { id: true, name: true, code: true } },
        equipment: { select: { id: true, name: true, assetTag: true } },
        technician: { select: { id: true, user: { select: { name: true } } } },
        workOrder: { select: { id: true, code: true, status: true } },
      },
    });

    // Keep the execution work order assignment in sync (§24 — one technician source).
    if (body.technicianId !== undefined && updated.workOrderId) {
      await db.workOrder.update({ where: { id: updated.workOrderId }, data: { technicianId: body.technicianId ?? null } }).catch(() => undefined);
    }

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: body.technicianId !== undefined ? "PM_ASSIGNED" : "PM_TASK_UPDATED",
      resourceType: "PmTask",
      resourceId: id,
      metadata: { code: task.code, fields: Object.keys(body) },
    });

    // Realtime: PM views update live.
    await emit({ type: EVENT_TYPES.PM_TASK_UPDATED, resourceType: "PmTask", resourceId: id, payload: { code: task.code, fields: Object.keys(body) }, actorType: "USER", actorId: user.id });
    return ok(updated);
  },
  PERMISSIONS.pm_manage
);
