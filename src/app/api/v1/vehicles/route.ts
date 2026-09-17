// MOHD.HMS ENTERPRISE — Vehicles API.
// GET  /api/v1/vehicles            (vehicles.read)  — list w/ search, status filter, pagination
// POST /api/v1/vehicles            (vehicles.manage) — create (code = nextNumber("VEH"))

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";

const VEHICLE_TYPES = ["VAN", "TRUCK", "CAR", "PICKUP", "OTHER"] as const;
const VEHICLE_STATUSES = ["AVAILABLE", "IN_USE", "MAINTENANCE", "RETIRED"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// NOTE: no .transform() here — absent keys must stay absent so partial PATCHes
// don't accidentally null dates that were never sent.
const dateField = z.string().regex(DATE_RE, "Use YYYY-MM-DD date format.").nullish();

function toDateOrNull(v: string | null | undefined): Date | null {
  return v ? new Date(`${v}T00:00:00.000Z`) : null;
}

const vehicleInclude = {
  assignedTechnician: { include: { user: { select: { id: true, name: true, email: true } } } },
} satisfies Prisma.VehicleInclude;

const createSchema = z.object({
  registrationNo: z.string().trim().min(1, "Registration number is required.").max(40),
  make: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  type: z.enum(VEHICLE_TYPES).optional(),
  assignedTechnicianId: z.string().trim().min(1).nullish(),
  odometer: z.coerce.number().int("Odometer must be a whole number.").min(0).max(10_000_000).optional(),
  lastServiceDate: dateField,
  nextServiceDue: dateField,
  notes: z.string().trim().max(2000).nullish(),
});

/** Ensure the technician exists; detach any other vehicle currently assigned to them. */
async function claimTechnician(technicianId: string) {
  const tech = await db.technicianProfile.findUnique({ where: { id: technicianId }, select: { id: true } });
  if (!tech) throw Errors.badRequest("Assigned technician was not found.");
  await db.vehicle.updateMany({ where: { assignedTechnicianId: technicianId }, data: { assignedTechnicianId: null } });
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    ""
  );
}

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const where: Prisma.VehicleWhereInput = {};
    if (q.status && VEHICLE_STATUSES.includes(q.status as (typeof VEHICLE_STATUSES)[number])) {
      where.status = q.status;
    }
    if (q.search) {
      where.OR = ["code", "registrationNo", "make", "model"].map((field) => ({
        [field]: { contains: q.search },
      }));
    }
    const sortable = ["code", "registrationNo", "status", "odometer", "createdAt"] as const;
    const orderBy: Prisma.VehicleOrderByWithRelationInput = sortable.includes(q.sort as (typeof sortable)[number])
      ? { [q.sort]: q.dir }
      : { code: "asc" };

    const [total, vehicles] = await Promise.all([
      db.vehicle.count({ where }),
      db.vehicle.findMany({
        where,
        include: vehicleInclude,
        orderBy,
        skip: q.skip,
        take: q.take,
      }),
    ]);
    return okList(vehicles, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.vehicles_read }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    const duplicate = await db.vehicle.findUnique({ where: { registrationNo: body.registrationNo }, select: { id: true } });
    if (duplicate) throw Errors.conflict("A vehicle with this registration number already exists.");

    if (body.assignedTechnicianId) await claimTechnician(body.assignedTechnicianId);

    const vehicle = await db.vehicle.create({
      data: {
        code: await nextNumber("VEH"),
        registrationNo: body.registrationNo,
        make: body.make ?? "",
        model: body.model ?? "",
        type: body.type ?? "VAN",
        assignedTechnicianId: body.assignedTechnicianId ?? null,
        status: "AVAILABLE",
        odometer: body.odometer ?? 0,
        lastServiceDate: toDateOrNull(body.lastServiceDate),
        nextServiceDue: toDateOrNull(body.nextServiceDue),
        notes: body.notes ?? "",
      },
      include: vehicleInclude,
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "VEHICLE_CREATED",
      resourceType: "Vehicle",
      resourceId: vehicle.id,
      metadata: { code: vehicle.code, registrationNo: vehicle.registrationNo, type: vehicle.type },
      ip: clientIp(req),
    });

    return ok(vehicle);
  },
  { permission: PERMISSIONS.vehicles_manage }
);
