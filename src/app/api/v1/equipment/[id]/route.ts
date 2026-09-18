// MOHD.HMS ENTERPRISE — Equipment module API (detail / update / retire).
// Detail includes maintenance history: complaints, work orders, PM tasks,
// inspections. DELETE retires the unit (status RETIRED) — history is kept.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { isStaff } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { clientIp } from "@/lib/hms/rate-limit";

/**
 * Next.js 16 App Router: dynamic route params arrive as a Promise in the 2nd
 * handler argument. Bridge: resolve params, then delegate to handler() so
 * auth/RBAC/centralized error handling still applies.
 */
const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

/** Customers may only see equipment owned by their customer record. */
async function loadScopedEquipment(id: string, user: SessionUser) {
  const equipment = await db.equipment.findUnique({
    where: { id },
    include: {
      location: { select: { id: true, name: true, code: true } },
      customer: { select: { id: true, companyName: true, code: true, contactPerson: true } },
    },
  });
  if (!equipment) throw Errors.notFound("Equipment not found.");
  if (!isStaff(user.role) && equipment.customerId !== user.customerId) {
    throw Errors.notFound("Equipment not found.");
  }
  return equipment;
}

export const GET = withId(PERMISSIONS.equipment_read, async (id, { user }) => {
  const equipment = await loadScopedEquipment(id, user);

  const [complaints, workOrders, pmTasks, inspections] = await Promise.all([
    db.complaint.findMany({
      where: { equipmentId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, code: true, title: true, status: true, priority: true, createdAt: true },
    }),
    db.workOrder.findMany({
      where: { equipmentId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, code: true, title: true, status: true, priority: true, totalCents: true, createdAt: true },
    }),
    db.pmTask.findMany({
      where: { equipmentId: id },
      orderBy: { dueDate: "desc" },
      take: 10,
      select: { id: true, code: true, dueDate: true, status: true, completedAt: true },
    }),
    db.inspectionReport.findMany({
      where: { equipmentId: id },
      orderBy: { inspectionDate: "desc" },
      take: 10,
      select: { id: true, code: true, title: true, type: true, status: true, overallCondition: true, inspectionDate: true },
    }),
  ]);

  return ok({ ...equipment, history: { complaints, workOrders, pmTasks, inspections } });
});

const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use a valid date (YYYY-MM-DD).");

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  serialNumber: z.string().max(120).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  category: z.string().max(60).optional(),
  locationId: z.string().min(1).nullable().optional(),
  customerId: z.string().min(1).nullable().optional(),
  installationDate: dateInput.nullable().optional(),
  warrantyExpiry: dateInput.nullable().optional(),
  pmFrequencyDays: z.number().int().min(1).max(3650).optional(),
  status: z.enum(["ACTIVE", "UNDER_MAINTENANCE", "RETIRED"]).optional(),
  notes: z.string().max(2000).optional(),
});

export const PATCH = withId(PERMISSIONS.equipment_update, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const ip = clientIp(req);

  const existing = await db.equipment.findUnique({ where: { id }, select: { id: true, assetTag: true } });
  if (!existing) throw Errors.notFound("Equipment not found.");

  if (body.locationId) {
    const loc = await db.location.findUnique({ where: { id: body.locationId }, select: { id: true } });
    if (!loc) throw Errors.badRequest("Selected location does not exist.", [{ path: "locationId", message: "Unknown location." }]);
  }
  if (body.customerId) {
    const cust = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!cust) throw Errors.badRequest("Selected customer does not exist.", [{ path: "customerId", message: "Unknown customer." }]);
  }

  const equipment = await db.equipment.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.serialNumber !== undefined ? { serialNumber: body.serialNumber.trim() } : {}),
      ...(body.manufacturer !== undefined ? { manufacturer: body.manufacturer.trim() } : {}),
      ...(body.model !== undefined ? { model: body.model.trim() } : {}),
      ...(body.category !== undefined ? { category: body.category.trim().toUpperCase() || "GENERAL" } : {}),
      ...(body.locationId !== undefined ? { locationId: body.locationId || null } : {}),
      ...(body.customerId !== undefined ? { customerId: body.customerId || null } : {}),
      ...(body.installationDate !== undefined ? { installationDate: body.installationDate ? new Date(body.installationDate) : null } : {}),
      ...(body.warrantyExpiry !== undefined ? { warrantyExpiry: body.warrantyExpiry ? new Date(body.warrantyExpiry) : null } : {}),
      ...(body.pmFrequencyDays !== undefined ? { pmFrequencyDays: body.pmFrequencyDays } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.notes !== undefined ? { notes: body.notes.trim() } : {}),
    },
    include: {
      location: { select: { id: true, name: true, code: true } },
      customer: { select: { id: true, companyName: true, code: true, contactPerson: true } },
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "EQUIPMENT_UPDATED",
    resourceType: "EQUIPMENT",
    resourceId: id,
    metadata: { assetTag: existing.assetTag, fields: Object.keys(body) },
    ip,
  });

  // Realtime (STEP 10): equipment edits propagate live.
  await emit({ type: EVENT_TYPES.EQUIPMENT_UPDATED, resourceType: "EQUIPMENT", resourceId: id, payload: { assetTag: existing.assetTag, fields: Object.keys(body) }, actorType: "USER", actorId: user.id });
  return ok(equipment);
});

export const DELETE = withId(PERMISSIONS.equipment_delete, async (id, { req, user }) => {
  const ip = clientIp(req);

  const existing = await db.equipment.findUnique({ where: { id }, select: { id: true, assetTag: true, name: true, status: true } });
  if (!existing) throw Errors.notFound("Equipment not found.");

  // Retire, never hard delete — maintenance and financial history must survive.
  const equipment = await db.equipment.update({
    where: { id },
    data: { status: "RETIRED" },
    include: {
      location: { select: { id: true, name: true, code: true } },
      customer: { select: { id: true, companyName: true, code: true, contactPerson: true } },
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "EQUIPMENT_RETIRED",
    resourceType: "EQUIPMENT",
    resourceId: id,
    metadata: { assetTag: existing.assetTag, name: existing.name },
    ip,
  });

  return ok(equipment);
});
