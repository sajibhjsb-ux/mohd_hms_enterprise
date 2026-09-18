// MOHD.HMS ENTERPRISE — Equipment module API (list / create).
// Every unit carries a unique qrToken for scan-to-open deep links.
// CUSTOMER role is scoped to equipment belonging to their own customer record.

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, Errors, parseBody, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { isStaff } from "@/lib/hms/rbac";
import { nextNumber, audit, notifyRole } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { clientIp } from "@/lib/hms/rate-limit";

const EQUIPMENT_SELECT = {
  id: true,
  assetTag: true,
  name: true,
  serialNumber: true,
  manufacturer: true,
  model: true,
  category: true,
  status: true,
  installationDate: true,
  warrantyExpiry: true,
  pmFrequencyDays: true,
  qrToken: true,
  notes: true,
  createdAt: true,
  customerId: true,
  location: { select: { id: true, name: true, code: true } },
  customer: { select: { id: true, companyName: true, code: true } },
  _count: { select: { complaints: true, workOrders: true, pmTasks: true } },
} satisfies Prisma.EquipmentSelect;

const SORT_FIELDS = ["createdAt", "assetTag", "name", "status", "category", "warrantyExpiry"] as const;

export const GET = handler(
  async ({ req, user }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const category = (sp.get("category") ?? "").trim();
    const staff = isStaff(user.role);

    const where: Prisma.EquipmentWhereInput = {};
    if (!staff) {
      where.customerId = user.customerId ?? "none";
    } else {
      if (q.customerId) where.customerId = q.customerId;
      if (category) where.category = category.toUpperCase();
      if (q.status) where.status = q.status.toUpperCase();
    }
    if (q.search) {
      where.OR = [
        { assetTag: { contains: q.search } },
        { name: { contains: q.search } },
        { serialNumber: { contains: q.search } },
        { manufacturer: { contains: q.search } },
        { model: { contains: q.search } },
      ];
    }

    const sortField = (SORT_FIELDS as readonly string[]).includes(q.sort) ? (q.sort as (typeof SORT_FIELDS)[number]) : "createdAt";

    const [items, total] = await Promise.all([
      db.equipment.findMany({
        where,
        orderBy: { [sortField]: q.dir },
        skip: q.skip,
        take: q.take,
        select: EQUIPMENT_SELECT,
      }),
      db.equipment.count({ where }),
    ]);

    return okList(items, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.equipment_read }
);

const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use a valid date (YYYY-MM-DD).");

const createSchema = z.object({
  assetTag: z.string().max(60).optional(),
  name: z.string().min(1, "Equipment name is required.").max(200),
  serialNumber: z.string().max(120).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  category: z.string().max(60).optional(),
  locationId: z.string().min(1).nullish(),
  customerId: z.string().min(1).nullish(),
  installationDate: dateInput.optional(),
  warrantyExpiry: dateInput.optional(),
  pmFrequencyDays: z.number().int().min(1).max(3650).optional(),
  notes: z.string().max(2000).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const ip = clientIp(req);

    if (body.locationId) {
      const loc = await db.location.findUnique({ where: { id: body.locationId }, select: { id: true } });
      if (!loc) throw Errors.badRequest("Selected location does not exist.", [{ path: "locationId", message: "Unknown location." }]);
    }
    if (body.customerId) {
      const cust = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true, companyName: true } });
      if (!cust) throw Errors.badRequest("Selected customer does not exist.", [{ path: "customerId", message: "Unknown customer." }]);
    }
    if (body.assetTag?.trim()) {
      const dup = await db.equipment.findUnique({ where: { assetTag: body.assetTag.trim() }, select: { id: true } });
      if (dup) throw Errors.conflict(`Asset tag ${body.assetTag.trim()} is already in use.`);
    }

    const assetTag = body.assetTag?.trim() || (await nextNumber("EQ"));

    const equipment = await db.equipment.create({
      data: {
        assetTag,
        name: body.name.trim(),
        serialNumber: body.serialNumber?.trim() ?? "",
        manufacturer: body.manufacturer?.trim() ?? "",
        model: body.model?.trim() ?? "",
        category: body.category?.trim().toUpperCase() || "GENERAL",
        locationId: body.locationId || null,
        customerId: body.customerId || null,
        installationDate: body.installationDate ? new Date(body.installationDate) : null,
        warrantyExpiry: body.warrantyExpiry ? new Date(body.warrantyExpiry) : null,
        pmFrequencyDays: body.pmFrequencyDays ?? 90,
        notes: body.notes?.trim() ?? "",
      },
      select: EQUIPMENT_SELECT,
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "EQUIPMENT_CREATED",
      resourceType: "EQUIPMENT",
      resourceId: equipment.id,
      metadata: { assetTag: equipment.assetTag, name: equipment.name, customerId: equipment.customerId },
      ip,
    });

    await notifyRole("ADMIN", {
      title: "Equipment registered",
      message: `${equipment.name} (${equipment.assetTag}) was added by ${user.name}.`,
      type: "INFO",
      resourceType: "EQUIPMENT",
      resourceId: equipment.id,
    });

    // Realtime (STEP 10): equipment lists update live for staff + owning customer.
    await emit({ type: EVENT_TYPES.EQUIPMENT_UPDATED, resourceType: "EQUIPMENT", resourceId: equipment.id, payload: { assetTag: equipment.assetTag, name: equipment.name }, actorType: "USER", actorId: user.id });
    return ok(equipment, 201);
  },
  { permission: PERMISSIONS.equipment_create }
);
