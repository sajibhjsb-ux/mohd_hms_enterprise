// MOHD.HMS ENTERPRISE — Vehicle detail API.
// PATCH  /api/v1/vehicles/[id]  (vehicles.manage) — update fields / reassign technician / status
// DELETE /api/v1/vehicles/[id]  (vehicles.manage) — retire vehicle (soft: status = RETIRED)

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { Permission } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import type { SessionUser } from "@/lib/hms/auth";

const VEHICLE_TYPES = ["VAN", "TRUCK", "CAR", "PICKUP", "OTHER"] as const;
const VEHICLE_STATUSES = ["AVAILABLE", "IN_USE", "MAINTENANCE", "RETIRED"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// NOTE: no .transform() here — absent keys must stay absent so partial PATCHes
// don't accidentally null dates that were never sent.
const dateField = z.string().regex(DATE_RE, "Use YYYY-MM-DD date format.").nullish();

function toDateOrNull(v: string | null | undefined): Date | null {
  return v ? new Date(`${v}T00:00:00.000Z`) : null;
}

const updateSchema = z.object({
  registrationNo: z.string().trim().min(1, "Registration number is required.").max(40).optional(),
  make: z.string().trim().max(60).nullish(),
  model: z.string().trim().max(60).nullish(),
  type: z.enum(VEHICLE_TYPES).optional(),
  assignedTechnicianId: z.string().trim().min(1).nullish(),
  status: z.enum(VEHICLE_STATUSES).optional(),
  odometer: z.coerce.number().int("Odometer must be a whole number.").min(0).max(10_000_000).optional(),
  lastServiceDate: dateField,
  nextServiceDue: dateField,
  notes: z.string().trim().max(2000).nullish(),
});

const vehicleInclude = {
  assignedTechnician: { include: { user: { select: { id: true, name: true, email: true } } } },
};

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    ""
  );
}

function withId(
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const PATCH = withId(PERMISSIONS.vehicles_manage, async (id, { req, user }) => {
  const vehicle = await db.vehicle.findUnique({ where: { id } });
  if (!vehicle) throw Errors.notFound("Vehicle not found.");

  const body = await parseBody(req, updateSchema);
  const fields = Object.keys(body);
  if (fields.length === 0) throw Errors.badRequest("No fields to update.");

  if (body.registrationNo && body.registrationNo !== vehicle.registrationNo) {
    const duplicate = await db.vehicle.findUnique({ where: { registrationNo: body.registrationNo }, select: { id: true } });
    if (duplicate) throw Errors.conflict("A vehicle with this registration number already exists.");
  }

  // Technician reassignment: a technician profile can hold only one vehicle —
  // detach it from the previous vehicle before claiming it here.
  if (body.assignedTechnicianId) {
    const tech = await db.technicianProfile.findUnique({ where: { id: body.assignedTechnicianId }, select: { id: true } });
    if (!tech) throw Errors.badRequest("Assigned technician was not found.");
    await db.vehicle.updateMany({
      where: { assignedTechnicianId: body.assignedTechnicianId, NOT: { id } },
      data: { assignedTechnicianId: null },
    });
  }

  const updated = await db.vehicle.update({
    where: { id },
    data: {
      ...(body.registrationNo !== undefined ? { registrationNo: body.registrationNo } : {}),
      ...(body.make !== undefined ? { make: body.make ?? "" } : {}),
      ...(body.model !== undefined ? { model: body.model ?? "" } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.assignedTechnicianId !== undefined ? { assignedTechnicianId: body.assignedTechnicianId ?? null } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.odometer !== undefined ? { odometer: body.odometer } : {}),
      ...(body.lastServiceDate !== undefined ? { lastServiceDate: toDateOrNull(body.lastServiceDate) } : {}),
      ...(body.nextServiceDue !== undefined ? { nextServiceDue: toDateOrNull(body.nextServiceDue) } : {}),
      ...(body.notes !== undefined ? { notes: body.notes ?? "" } : {}),
    },
    include: vehicleInclude,
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "VEHICLE_UPDATED",
    resourceType: "Vehicle",
    resourceId: updated.id,
    metadata: { code: updated.code, fields },
    ip: clientIp(req),
  });

  return ok(updated);
});

export const DELETE = withId(PERMISSIONS.vehicles_manage, async (id, { req, user }) => {
  const vehicle = await db.vehicle.findUnique({ where: { id } });
  if (!vehicle) throw Errors.notFound("Vehicle not found.");

  // Soft delete: fleet history (assignments, audits) stays intact.
  const updated = await db.vehicle.update({
    where: { id },
    data: { status: "RETIRED" },
    include: vehicleInclude,
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "VEHICLE_RETIRED",
    resourceType: "Vehicle",
    resourceId: updated.id,
    metadata: { code: updated.code, registrationNo: updated.registrationNo },
    ip: clientIp(req),
  });

  return ok(updated);
});
