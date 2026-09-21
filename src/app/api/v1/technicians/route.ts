// MOHD.HMS ENTERPRISE — Technicians module API (workforce roster).
// Lists TechnicianProfile rows with live workload counts. Permission: users.read
// (roster is an operational view; profile edits require users.update).

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, Errors, parseBody, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { nextNumber } from "@/lib/hms/services";
import { toCents } from "@/lib/hms/format";

const TECH_SELECT = {
  id: true,
  employeeNo: true,
  skills: true,
  specialty: true,
  hourlyRateCents: true,
  status: true,
  user: {
    select: {
      id: true, name: true, email: true, phone: true, status: true,
      // Job position (role/position spec §18) — display/specialization only;
      // authorization stays with User.role.
      position: { select: { id: true, name: true } },
    },
  },
  _count: {
    select: {
      workOrders: { where: { status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"] } } },
      complaints: { where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } } },
      pmTasks: { where: { status: { in: ["SCHEDULED", "OVERDUE", "IN_PROGRESS"] } } },
    },
  },
} satisfies Prisma.TechnicianProfileSelect;

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const specialty = (sp.get("specialty") ?? "").trim();
    const where: Prisma.TechnicianProfileWhereInput = {};

    // Role-change spec §13 — a user downgraded TECHNICIAN → CUSTOMER keeps their
    // profile for HISTORY (old work orders stay linked) but must disappear from
    // the active roster and every assignment dropdown. RETIRED profiles are only
    // listed when explicitly requested; re-promoting the user reactivates the
    // SAME profile (same TEC number — one canonical user↔technician identity).
    if (q.status) where.status = q.status.toUpperCase();
    else where.status = { not: "RETIRED" };
    if (specialty) where.specialty = specialty.toUpperCase();
    if (q.search) {
      where.OR = [
        { user: { name: { contains: q.search } } },
        { user: { email: { contains: q.search } } },
        { employeeNo: { contains: q.search } },
        { skills: { contains: q.search } },
      ];
    }

    // Allow sorting by technician name (relation) or plain columns.
    const dir: "asc" | "desc" = q.dir === "asc" ? "asc" : "desc";
    const sortPlain = (["employeeNo", "specialty", "status"].includes(q.sort) ? q.sort : "employeeNo") as
      | "employeeNo"
      | "specialty"
      | "status";
    const orderBy: Prisma.TechnicianProfileOrderByWithRelationInput =
      q.sort === "name" ? { user: { name: dir } } : ({ [sortPlain]: dir } as Prisma.TechnicianProfileOrderByWithRelationInput);

    const [profiles, total] = await Promise.all([
      db.technicianProfile.findMany({
        where,
        orderBy,
        skip: q.skip,
        take: q.take,
        select: TECH_SELECT,
      }),
      db.technicianProfile.count({ where }),
    ]);

    const completedGroups = await db.workOrder.groupBy({
      by: ["technicianId"],
      _count: { _all: true },
      where: { status: "COMPLETED", technicianId: { in: profiles.map((p) => p.id) } },
    });
    const completedMap = new Map(completedGroups.map((g) => [g.technicianId, g._count._all]));

    const items = profiles.map(({ _count, ...p }) => ({
      ...p,
      openWorkOrders: _count.workOrders,
      completedWorkOrders: completedMap.get(p.id) ?? 0,
      openComplaints: _count.complaints,
      openPmTasks: _count.pmTasks,
    }));

    return okList(items, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.users_read }
);

/**
 * Create a technician profile for an existing user (convenience endpoint used
 * when a user is promoted to TECHNICIAN without a profile).
 */
const createSchema = z.object({
  userId: z.string().min(1),
  specialty: z.string().max(60).optional(),
  skills: z.string().max(500).optional(),
  hourlyRate: z.union([z.number(), z.string()]).optional(),
});

export const POST = handler(
  async ({ req }) => {
    const body = await parseBody(req, createSchema);

    const u = await db.user.findUnique({ where: { id: body.userId }, select: { id: true } });
    if (!u) throw Errors.badRequest("User does not exist.", [{ path: "userId", message: "Unknown user." }]);
    const existing = await db.technicianProfile.findUnique({ where: { userId: body.userId }, select: { id: true } });
    if (existing) throw Errors.conflict("This user already has a technician profile.");

    const profile = await db.technicianProfile.create({
      data: {
        userId: body.userId,
        employeeNo: await nextNumber("TEC"),
        specialty: body.specialty?.trim() || "GENERAL",
        skills: body.skills?.trim() ?? "",
        hourlyRateCents: body.hourlyRate !== undefined ? toCents(body.hourlyRate) : 0,
        status: "AVAILABLE",
      },
      select: TECH_SELECT,
    });

    return ok({ ...profile, _count: undefined }, 201);
  },
  { permission: PERMISSIONS.users_update }
);
