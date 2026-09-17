// MOHD.HMS ENTERPRISE — Work Orders API: list + create.
// Workflow: PENDING → ACCEPTED → IN_PROGRESS → COMPLETED (+ ON_HOLD, CANCELLED).
// Money is integer cents. Stock deduction happens at completion (transition route).
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { audit, nextNumber, notify } from "@/lib/hms/services";
import { PERMISSIONS, PRIORITIES } from "@/lib/hms/constants";
import { WO_INCLUDE, WO_DETAIL_INCLUDE } from "./_lib";

const materialSchema = z.object({
  inventoryItemId: z.string().min(1).optional(),
  name: z.string().min(1, "Material name is required.").max(200),
  quantity: z.number().positive("Quantity must be greater than zero.").max(1_000_000),
  unitCostCents: z.number().int("unitCostCents must be integer cents.").min(0),
});

const createSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters.").max(200),
  description: z.string().max(5000).optional(),
  customerId: z.string().min(1, "Customer is required."),
  equipmentId: z.string().min(1).optional(),
  complaintId: z.string().min(1).optional(),
  technicianId: z.string().min(1).optional(),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  scheduledDate: z.string().max(40).optional(),
  checklist: z.array(z.string().min(1).max(300)).max(50).optional(),
  materials: z.array(materialSchema).max(100).optional(),
});

export const GET = handler(
  async ({ req, user }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const technicianId = (sp.get("technicianId") ?? "").trim();
    const complaintId = (sp.get("complaintId") ?? "").trim();

    const where: Prisma.WorkOrderWhereInput = {};
    if (user.role === "CUSTOMER") {
      where.customerId = user.customerId ?? "none";
    } else if (user.role === "TECHNICIAN") {
      const profile = await db.technicianProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
      where.technicianId = profile?.id ?? "none";
    } else if (q.customerId) {
      where.customerId = q.customerId;
    }

    if (q.status) where.status = q.status;
    if (technicianId && user.role !== "CUSTOMER") where.technicianId = technicianId;
    if (complaintId && user.role !== "CUSTOMER") where.complaintId = complaintId;
    if (q.search) {
      where.AND = [{ OR: [{ code: { contains: q.search } }, { title: { contains: q.search } }] }];
    }

    const [rows, total] = await Promise.all([
      db.workOrder.findMany({
        where,
        include: WO_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: q.skip,
        take: q.take,
      }),
      db.workOrder.count({ where }),
    ]);
    return okList(rows, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.work_orders_read }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!customer) throw Errors.badRequest("Customer not found.");

    if (body.equipmentId) {
      const equipment = await db.equipment.findUnique({ where: { id: body.equipmentId }, select: { id: true, customerId: true } });
      if (!equipment) throw Errors.badRequest("Equipment not found.");
      if (equipment.customerId !== body.customerId) throw Errors.badRequest("Equipment does not belong to the selected customer.");
    }

    if (body.complaintId) {
      const complaint = await db.complaint.findUnique({ where: { id: body.complaintId }, select: { id: true, customerId: true, status: true } });
      if (!complaint) throw Errors.badRequest("Complaint not found.");
      if (complaint.customerId !== body.customerId) throw Errors.badRequest("Complaint does not belong to the selected customer.");
      // Link only — complaint lifecycle is driven by its own workflow.
    }

    let technicianUserId: string | null = null;
    if (body.technicianId) {
      const tech = await db.technicianProfile.findUnique({ where: { id: body.technicianId }, select: { id: true, userId: true } });
      if (!tech) throw Errors.badRequest("Technician profile not found.");
      technicianUserId = tech.userId;
    }

    const materials = body.materials ?? [];
    const materialsTotalCents = materials.reduce((sum, m) => sum + Math.round(m.quantity * m.unitCostCents), 0);

    const scheduledDate = body.scheduledDate ? new Date(body.scheduledDate) : null;
    if (scheduledDate && isNaN(scheduledDate.getTime())) throw Errors.badRequest("scheduledDate is not a valid date.");

    const code = await nextNumber("WO");
    const created = await db.workOrder.create({
      data: {
        code,
        title: body.title,
        description: body.description ?? "",
        priority: body.priority,
        status: "PENDING",
        customerId: body.customerId,
        equipmentId: body.equipmentId ?? null,
        complaintId: body.complaintId ?? null,
        technicianId: body.technicianId ?? null,
        scheduledDate: scheduledDate && !isNaN(scheduledDate.getTime()) ? scheduledDate : null,
        labourTotalCents: 0,
        materialsTotalCents,
        totalCents: materialsTotalCents,
        checklist: {
          create: (body.checklist ?? []).map((label, index) => ({ label, sortOrder: index })),
        },
        materials: {
          create: materials.map((m) => {
            const totalCents = Math.round(m.quantity * m.unitCostCents);
            return {
              inventoryItemId: m.inventoryItemId ?? null,
              name: m.name,
              quantity: m.quantity,
              unitCostCents: m.unitCostCents,
              totalCents,
            };
          }),
        },
      },
      include: WO_DETAIL_INCLUDE,
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_CREATED",
      resourceType: "WORK_ORDER", resourceId: created.id,
      metadata: { code, customerId: body.customerId, complaintId: body.complaintId ?? null, technicianId: body.technicianId ?? null },
    });
    if (technicianUserId) {
      await notify({
        userId: technicianUserId, title: "New work order",
        message: `Work order ${code} has been assigned to you: ${body.title}`,
        type: "INFO", resourceType: "WORK_ORDER", resourceId: created.id,
      });
    }

    return ok(created, 201);
  },
  { permission: PERMISSIONS.work_orders_create }
);
