// MOHD.HMS ENTERPRISE — PM findings / observations (PM §19).
// GET  /api/v1/pm/findings — filtered list (pmTaskId | equipmentId | planId) or recent 50.
// POST /api/v1/pm/findings — record a finding; HIGH/CRITICAL escalates to supervisors.
// Equipment is resolved from the referenced PM task / work order when not given.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, PM_FINDING_SEVERITIES } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notifyRole } from "@/lib/hms/services";

const findingInclude = {
  equipment: { select: { id: true, name: true, assetTag: true } },
  pmTask: { select: { id: true, code: true } },
  correctiveWorkOrder: { select: { id: true, code: true, status: true } },
} as const;

export const GET = handler(
  async ({ req, user }) => {
    const sp = new URL(req.url).searchParams;
    const pmTaskId = (sp.get("pmTaskId") ?? "").trim();
    const equipmentId = (sp.get("equipmentId") ?? "").trim();
    const planId = (sp.get("planId") ?? "").trim();

    const where: Record<string, unknown> = {};
    if (pmTaskId) where.pmTaskId = pmTaskId;
    if (equipmentId) where.equipmentId = equipmentId;
    if (planId) where.planId = planId;
    // §44 defense-in-depth — customers only ever see findings on own equipment,
    // sanitized to the non-internal fields.
    const isCustomer = user.role === "CUSTOMER";
    if (isCustomer) {
      where.equipment = { is: { customerId: user.customerId ?? "__none__" } };
    }

    // No filter given → recent activity feed (max 50).
    const recentOnly = !pmTaskId && !equipmentId && !planId;
    const rows = await db.pmFinding.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...(recentOnly ? { take: 50 } : {}),
      include: findingInclude,
    });

    if (isCustomer) {
      return ok(rows.map((f) => ({
        id: f.id, title: f.title, description: f.description,
        severity: f.severity, recommendation: f.recommendation, createdAt: f.createdAt,
      })));
    }
    return ok(rows);
  },
  { permission: PERMISSIONS.pm_read }
);

const postSchema = z.object({
  pmTaskId: z.string().min(1).optional(),
  workOrderId: z.string().min(1).optional(),
  equipmentId: z.string().min(1).optional(),
  title: z.string().min(3, "Title must be at least 3 characters.").max(300),
  description: z.string().max(4000).default(""),
  severity: z.enum(PM_FINDING_SEVERITIES).default("MEDIUM"),
  cause: z.string().max(2000).default(""),
  recommendation: z.string().max(2000).default(""),
  immediateAction: z.string().max(2000).default(""),
  followUpRequired: z.boolean().default(false),
});

export const POST = handler(
  async ({ req, user }) => {
    // Layered permission (§41): handler gate is pm_read; recording needs
    // pm_execute (technicians) or pm_manage (supervisors/admins).
    const allowed = roleCan(user.role, PERMISSIONS.pm_execute) || roleCan(user.role, PERMISSIONS.pm_manage);
    if (!allowed) throw Errors.forbidden();

    const body = await parseBody(req, postSchema);

    // Resolve the equipment: explicit → from PM task → from work order.
    let equipmentId = body.equipmentId ?? null;
    let planId: string | null = null;
    let taskCode: string | null = null;
    if (body.pmTaskId) {
      const task = await db.pmTask.findUnique({ where: { id: body.pmTaskId }, select: { id: true, equipmentId: true, planId: true, code: true } });
      if (!task) throw Errors.notFound("PM task not found.");
      equipmentId ??= task.equipmentId;
      planId = task.planId;
      taskCode = task.code;
    }
    if (body.workOrderId) {
      const wo = await db.workOrder.findUnique({ where: { id: body.workOrderId }, select: { id: true, equipmentId: true } });
      if (!wo) throw Errors.notFound("Work order not found.");
      equipmentId ??= wo.equipmentId;
    }
    if (!equipmentId) {
      throw Errors.badRequest("equipmentId is required when no PM task or work order is referenced.");
    }
    const equipment = await db.equipment.findUnique({ where: { id: equipmentId }, select: { id: true, name: true, assetTag: true } });
    if (!equipment) throw Errors.notFound("Equipment not found.");

    const created = await db.pmFinding.create({
      data: {
        pmTaskId: body.pmTaskId ?? null,
        workOrderId: body.workOrderId ?? null,
        planId,
        equipmentId,
        title: body.title,
        description: body.description,
        severity: body.severity,
        cause: body.cause,
        recommendation: body.recommendation,
        immediateAction: body.immediateAction,
        followUpRequired: body.followUpRequired,
        createdById: user.id,
      },
      include: findingInclude,
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_FINDING_ADDED",
      resourceType: "PM_FINDING",
      resourceId: created.id,
      metadata: { title: created.title, severity: created.severity, ...(taskCode ? { taskCode } : {}) },
    });

    // High-severity findings escalate to supervisors immediately.
    if (created.severity === "HIGH" || created.severity === "CRITICAL") {
      await notifyRole("SUPERVISOR", {
        title: "PM finding",
        message: `${created.severity} PM finding "${created.title}" on ${equipment.name} (${equipment.assetTag})${taskCode ? ` during ${taskCode}` : ""} requires attention.`,
        type: "WARNING",
        resourceType: "PM_FINDING",
        resourceId: created.id,
      });
    }

    return ok(created, 201);
  },
  { permission: PERMISSIONS.pm_read }
);
