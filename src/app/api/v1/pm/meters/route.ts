// MOHD.HMS ENTERPRISE — equipment meters for PM (§9–§11).
// GET  /api/v1/pm/meters?equipmentId=… — meters with their last 20 readings each.
// POST /api/v1/pm/meters — register a meter on an asset (pm_manage).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

export const GET = handler(
  async ({ req, user }) => {
    const sp = new URL(req.url).searchParams;
    const equipmentId = (sp.get("equipmentId") ?? "").trim();

    const where: Record<string, unknown> = {};
    if (equipmentId) where.equipmentId = equipmentId;
    // §44 defense-in-depth — customers only ever see their own equipment's meters.
    if (user.role === "CUSTOMER") {
      where.equipment = { is: { customerId: user.customerId ?? "__none__" } };
    }

    const meters = await db.equipmentMeter.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...(equipmentId ? {} : { take: 50 }),
      include: {
        equipment: { select: { id: true, name: true, assetTag: true } },
        readings: { orderBy: { readingDate: "desc" }, take: 20 },
      },
    });

    // recordedById is a plain reference (no Prisma relation) — resolve names once.
    const userIds = [...new Set(meters.flatMap((m) => m.readings.map((r) => r.recordedById)).filter((v): v is string => !!v))];
    const users = userIds.length
      ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    const data = meters.map((m) => ({
      ...m,
      readings: m.readings.map((r) => ({
        id: r.id,
        reading: r.reading,
        readingDate: r.readingDate,
        source: r.source,
        notes: r.notes,
        recordedBy: r.recordedById ? { id: r.recordedById, name: nameById.get(r.recordedById) ?? null } : null,
      })),
    }));
    return ok(data);
  },
  { permission: PERMISSIONS.pm_read }
);

const createSchema = z.object({
  equipmentId: z.string().min(1, "Equipment is required."),
  name: z.string().min(1, "Meter name is required.").max(100),
  unit: z.string().max(20).default("h"),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const equipment = await db.equipment.findUnique({ where: { id: body.equipmentId }, select: { id: true, assetTag: true } });
    if (!equipment) throw Errors.notFound("Equipment not found.");

    const meter = await db.equipmentMeter.create({
      data: { equipmentId: body.equipmentId, name: body.name, unit: body.unit },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_METER_CREATED",
      resourceType: "EQUIPMENT_METER",
      resourceId: meter.id,
      metadata: { equipmentId: body.equipmentId, assetTag: equipment.assetTag, name: body.name, unit: body.unit },
    });

    return ok(meter, 201);
  },
  { permission: PERMISSIONS.pm_manage }
);
