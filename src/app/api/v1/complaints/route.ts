// MOHD.HMS ENTERPRISE — Complaints API: list + create.
// Workflow: NEW → ASSIGNED → IN_PROGRESS → COMPLETED → CONFIRMED → CLOSED (+ CANCELLED).
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { isStaff } from "@/lib/hms/rbac";
import { audit, nextNumber, notify, notifyRole } from "@/lib/hms/services";
import { PERMISSIONS, PRIORITIES } from "@/lib/hms/constants";
import { COMPLAINT_INCLUDE, complaintScopeWhere } from "./_lib";
import { assertCustomerProfileComplete } from "@/lib/hms/customer-profile";
import { assertTermsAccepted } from "@/lib/hms/legal/legal";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const createSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters.").max(200),
  description: z.string().min(3, "Description must be at least 3 characters.").max(5000),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  customerId: z.string().min(1).optional(),
  equipmentId: z.string().min(1).optional(),
});

export const GET = handler(
  async ({ req, user }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const priority = (sp.get("priority") ?? "").trim();
    const technicianId = (sp.get("technicianId") ?? "").trim();
    const mine = sp.get("mine") === "1";

    const where: Prisma.ComplaintWhereInput = await complaintScopeWhere(user);

    // Staff-side filters (customers are pinned to their own scope above)
    if (isStaff(user.role) && q.customerId) where.customerId = q.customerId;
    if (q.status) where.status = q.status;
    if (priority) where.priority = priority;
    if (technicianId && user.role !== "CUSTOMER") where.assignedTechnicianId = technicianId;
    if (mine && user.role === "TECHNICIAN") {
      const profile = await db.technicianProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
      where.assignedTechnicianId = profile?.id ?? "none";
    }
    if (q.search) {
      where.AND = [
        {
          OR: [
            { code: { contains: q.search } },
            { title: { contains: q.search } },
            { description: { contains: q.search } },
          ],
        },
      ];
    }

    const [rows, total] = await Promise.all([
      db.complaint.findMany({
        where,
        include: COMPLAINT_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: q.skip,
        take: q.take,
      }),
      db.complaint.count({ where }),
    ]);
    return okList(rows, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.complaints_read }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    dedupeSubmission({ userId: user.id, route: "POST /api/v1/complaints", body });

    let customerId: string;
    if (user.role === "CUSTOMER") {
      // Backend-authoritative onboarding gate: no job/service request until the
      // customer's mobile number and address are on their canonical Customer
      // record. Even direct API calls are rejected with the machine-readable
      // PROFILE_INCOMPLETE code (spec §8/§10/§12).
      await assertCustomerProfileComplete(user);
      // Backend-authoritative consent gate: the current Terms & Conditions must
      // have been accepted (records an append-only acceptance) before a
      // customer can submit service requests (spec §21/§26).
      await assertTermsAccepted(user);
      if (!user.customerId) throw Errors.forbidden("Your account is not linked to a customer.");
      customerId = user.customerId; // portal users can only file for themselves
    } else {
      if (!body.customerId) throw Errors.badRequest("customerId is required.");
      customerId = body.customerId;
    }

    const customer = await db.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) throw Errors.badRequest("Customer not found.");

    if (body.equipmentId) {
      const equipment = await db.equipment.findUnique({ where: { id: body.equipmentId }, select: { id: true, customerId: true } });
      if (!equipment) throw Errors.badRequest("Equipment not found.");
      if (equipment.customerId !== customerId) throw Errors.badRequest("Equipment does not belong to the selected customer.");
    }

    const code = await nextNumber("CPT");
    const created = await db.complaint.create({
      data: {
        code,
        customerId,
        title: body.title,
        description: body.description,
        priority: body.priority,
        equipmentId: body.equipmentId ?? null,
        status: "NEW",
        createdById: user.id,
        statusHistory: {
          create: { fromStatus: "NEW", toStatus: "NEW", changedById: user.id, note: "Complaint created" },
        },
      },
      include: COMPLAINT_INCLUDE,
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "COMPLAINT_CREATED",
      resourceType: "COMPLAINT", resourceId: created.id,
      metadata: { code, priority: body.priority, customerId },
    });
    await Promise.all([
      notifyRole("SUPERVISOR", { title: "New complaint", message: `New complaint ${code}: ${body.title}`, type: "INFO", resourceType: "COMPLAINT", resourceId: created.id }),
      notifyRole("ADMIN", { title: "New complaint", message: `New complaint ${code}: ${body.title}`, type: "INFO", resourceType: "COMPLAINT", resourceId: created.id }),
    ]);
    // Outbox: downstream workflows (urgency escalations, SLA tracking) key off this event.
    await emit({ type: EVENT_TYPES.COMPLAINT_CREATED, resourceType: "COMPLAINT", resourceId: created.id, payload: { code, priority: body.priority, customerId }, actorType: "USER", actorId: user.id });

    return ok(created, 201);
  },
  { permission: PERMISSIONS.complaints_create }
);
