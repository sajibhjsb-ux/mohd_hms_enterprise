// MOHD.HMS ENTERPRISE — Technicians module API (detail / update).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";
import { toCents } from "@/lib/hms/format";
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

export const GET = withId(PERMISSIONS.users_read, async (id) => {
  const profile = await db.technicianProfile.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, status: true } },
      _count: { select: { complaints: true, workOrders: true, pmTasks: true, inspections: true } },
    },
  });
  if (!profile) throw Errors.notFound("Technician profile not found.");

  const [openWorkOrders, completedWorkOrders] = await Promise.all([
    db.workOrder.count({ where: { technicianId: id, status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"] } } }),
    db.workOrder.count({ where: { technicianId: id, status: "COMPLETED" } }),
  ]);

  return ok({ ...profile, openWorkOrders, completedWorkOrders });
});

const patchSchema = z.object({
  skills: z.string().max(500).optional(),
  specialty: z.string().max(60).optional(),
  hourlyRate: z.union([z.number(), z.string()]).optional(),
  status: z.enum(["AVAILABLE", "ON_JOB", "OFF_DUTY"]).optional(),
  vehicleId: z.string().min(1).nullable().optional(),
});

export const PATCH = withId(PERMISSIONS.users_update, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);
  const ip = clientIp(req);

  const existing = await db.technicianProfile.findUnique({
    where: { id },
    select: { id: true, employeeNo: true, userId: true },
  });
  if (!existing) throw Errors.notFound("Technician profile not found.");

  const profile = await db.technicianProfile.update({
    where: { id },
    data: {
      ...(body.skills !== undefined ? { skills: body.skills.trim() } : {}),
      ...(body.specialty !== undefined ? { specialty: body.specialty.trim().toUpperCase() } : {}),
      ...(body.hourlyRate !== undefined ? { hourlyRateCents: toCents(body.hourlyRate) } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.vehicleId !== undefined ? { vehicleId: body.vehicleId || null } : {}),
    },
    include: { user: { select: { id: true, name: true, email: true, phone: true, status: true } } },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "TECHNICIAN_UPDATED",
    resourceType: "TECHNICIAN",
    resourceId: id,
    metadata: { employeeNo: existing.employeeNo, fields: Object.keys(body) },
    ip,
  });

  return ok(profile);
});
