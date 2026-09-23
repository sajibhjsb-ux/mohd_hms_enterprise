// MOHD.HMS ENTERPRISE — Work Orders API: list + create.
// Workflow: PENDING → ACCEPTED → IN_PROGRESS → COMPLETED (+ ON_HOLD, CANCELLED).
// Money is integer cents. Stock deduction happens at completion (transition route).
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ciContains, normalizeSearchTerm } from "@/lib/hms/text-search";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { audit, nextNumber, notify } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";
import { PERMISSIONS, PRIORITIES } from "@/lib/hms/constants";
import { WO_INCLUDE, WO_DETAIL_INCLUDE } from "./_lib";
import { ensureQr } from "@/lib/hms/qr/service";

const materialSchema = z.object({
  inventoryItemId: z.string().min(1).optional(),
  name: z.string().min(1, "Material name is required.").max(200),
  quantity: z.number().positive("Quantity must be greater than zero.").max(1_000_000),
  unit: z.string().trim().max(20).optional(),
  unitCostCents: z.number().int("unitCostCents must be integer cents.").min(0).optional(),
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
    // PM §26/§44 — source filter so PM/Corrective work can be listed separately.
    const source = (sp.get("source") ?? "").trim();
    if (source) {
      const upper = source.toUpperCase();
      if (!["GENERAL", "COMPLAINT", "PM", "CORRECTIVE"].includes(upper)) {
        throw Errors.badRequest("Unknown work order source. Use GENERAL, COMPLAINT, PM or CORRECTIVE.");
      }
      where.sourceType = upper;
    }
    if (q.search) {
      const term = ciContains(normalizeSearchTerm(q.search));
      where.AND = [{ OR: [{ code: term }, { title: term }] }];
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
    // §45 — double-click / retry must never mint two work orders.
    dedupeSubmission({ userId: user.id, route: "POST /api/v1/work-orders", body });

    const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
    if (!customer) throw Errors.badRequest("Customer not found.");

    if (body.equipmentId) {
      const equipment = await db.equipment.findUnique({ where: { id: body.equipmentId }, select: { id: true, customerId: true } });
      if (!equipment) throw Errors.badRequest("Equipment not found.");
      if (equipment.customerId !== body.customerId) throw Errors.badRequest("Equipment does not belong to the selected customer.");
    }

    if (body.complaintId) {
      // §9/§45 — a complaint must end up with exactly ONE work order. If one
      // already exists (any creation path), return it instead of duplicating.
      const existing = await db.workOrder.findFirst({
        where: { complaintId: body.complaintId },
        include: WO_DETAIL_INCLUDE,
        orderBy: { createdAt: "asc" },
      });
      if (existing) return ok({ alreadyLinked: true, workOrder: existing }, 200);
    }

    let complaintForLink: { id: string; customerId: string; status: string; priority: string; equipmentId: string | null; assignedTechnicianId: string | null } | null = null;
    if (body.complaintId) {
      const complaint = await db.complaint.findUnique({
        where: { id: body.complaintId },
        select: { id: true, customerId: true, status: true, priority: true, equipmentId: true, assignedTechnicianId: true },
      });
      if (!complaint) throw Errors.badRequest("Complaint not found.");
      if (complaint.customerId !== body.customerId) throw Errors.badRequest("Complaint does not belong to the selected customer.");
      if (complaint.status === "CANCELLED") throw Errors.invalidTransition("Cannot create a work order for a cancelled complaint.");
      complaintForLink = complaint;
    }

    let technicianUserId: string | null = null;
    if (body.technicianId) {
      const tech = await db.technicianProfile.findUnique({ where: { id: body.technicianId }, select: { id: true, userId: true } });
      if (!tech) throw Errors.badRequest("Technician profile not found.");
      technicianUserId = tech.userId;
    }

    const materials = body.materials ?? [];
    const materialsTotalCents = materials.reduce((sum, m) => sum + Math.round(m.quantity * (m.unitCostCents ?? 0)), 0);

    const scheduledDate = body.scheduledDate ? new Date(body.scheduledDate) : null;
    if (scheduledDate && isNaN(scheduledDate.getTime())) throw Errors.badRequest("scheduledDate is not a valid date.");

    const code = await nextNumber("WO");
    const now = new Date();

    // §9/§10/§44 — the work order, the relationship and the complaint status
    // move are ONE PostgreSQL transaction: if any step fails, nothing is
    // written and the complaint stays in its previous valid state.
    const created = await db.$transaction(async (tx) => {
      const workOrder = await tx.workOrder.create({
      data: {
        code,
        title: body.title,
        description: body.description ?? "",
        priority: body.priority,
        status: "PENDING",
        // §9 — explicit source so the source=COMPLAINT filter works.
        sourceType: complaintForLink ? "COMPLAINT" : "GENERAL",
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
            const totalCents = Math.round(m.quantity * (m.unitCostCents ?? 0));
            return {
              inventoryItemId: m.inventoryItemId ?? null,
              name: m.name,
              quantity: m.quantity,
              unit: m.unit && m.unit.length > 0 ? m.unit : "pcs",
              unitCostCents: m.unitCostCents,
              totalCents,
              // Inventory spec §11 — creation is a REQUEST, never a stock change.
              status: "REQUESTED",
            };
          }),
        },
      },
      });

      // §10 — a successful work-order creation moves the complaint to
      // IN_PROGRESS (only when it has not progressed beyond it already).
      if (complaintForLink && ["NEW", "ASSIGNED"].includes(complaintForLink.status)) {
        await tx.complaint.update({
          where: { id: complaintForLink.id },
          data: {
            status: "IN_PROGRESS",
            startedAt: now,
            assignedTechnicianId: complaintForLink.assignedTechnicianId ?? body.technicianId ?? null,
            assignedAt: complaintForLink.assignedTechnicianId ? undefined : now,
          },
        });
        await tx.complaintStatusHistory.create({
          data: {
            complaintId: complaintForLink.id,
            fromStatus: complaintForLink.status,
            toStatus: "IN_PROGRESS",
            changedById: user.id,
            note: `Work order ${code} created`,
          },
        });
      }
      return workOrder;
    });

    const detailed = await db.workOrder.findUnique({ where: { id: created.id }, include: WO_DETAIL_INCLUDE });

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
    // Realtime (STEP 13/39): technician + staff + customer see the new WO live.
    await emit({ type: EVENT_TYPES.WORK_ORDER_CREATED, resourceType: "WORK_ORDER", resourceId: created.id, payload: { code, workOrderId: created.id, customerId: body.customerId }, actorType: "USER", actorId: user.id });

    // Central QR identity at creation (ch.35 §60) — infrastructure only (§59).
    await ensureQr("WORK_ORDER", created.id, { issuedById: user.id, auditContext: "work-order-created" });

    return ok(detailed ?? created, 201);
  },
  { permission: PERMISSIONS.work_orders_create }
);
