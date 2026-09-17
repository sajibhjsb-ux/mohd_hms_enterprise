// MOHD.HMS ENTERPRISE — Complaint detail (GET) + edit while NEW (PATCH).
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { PERMISSIONS, PRIORITIES } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { COMPLAINT_DETAIL_INCLUDE, assertViewComplaint, technicianProfileIdFor } from "../_lib";

type Ctx = { req: NextRequest; user: SessionUser };

/** Next 16: params are async — bind the id, then run through the standard handler wrapper. */
function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

export const GET = withId(
  async (id, { user }) => {
    const complaint = await db.complaint.findUnique({ where: { id }, include: COMPLAINT_DETAIL_INCLUDE });
    if (!complaint) throw Errors.notFound("Complaint not found.");
    const profileId = user.role === "TECHNICIAN" ? await technicianProfileIdFor(user.id) : null;
    assertViewComplaint(user, complaint, profileId);

    // ComplaintStatusHistory stores changedById without a relation — resolve names explicitly.
    const changerIds = [...new Set(complaint.statusHistory.map((h) => h.changedById).filter((v): v is string => !!v))];
    const changers = changerIds.length
      ? await db.user.findMany({ where: { id: { in: changerIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(changers.map((u) => [u.id, u.name]));

    return ok({
      ...complaint,
      statusHistory: complaint.statusHistory.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        note: h.note,
        createdAt: h.createdAt,
        changedById: h.changedById,
        changedByName: h.changedById ? nameById.get(h.changedById) ?? null : null,
      })),
    });
  },
  { permission: PERMISSIONS.complaints_read }
);

const patchSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(3).max(5000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  equipmentId: z.string().min(1).nullable().optional(),
});

export const PATCH = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, patchSchema);
    const complaint = await db.complaint.findUnique({ where: { id }, include: COMPLAINT_DETAIL_INCLUDE });
    if (!complaint) throw Errors.notFound("Complaint not found.");
    const profileId = user.role === "TECHNICIAN" ? await technicianProfileIdFor(user.id) : null;
    assertViewComplaint(user, complaint, profileId);

    const isCreator = complaint.createdById === user.id;
    if (!isCreator && !roleCan(user.role, PERMISSIONS.complaints_update)) throw Errors.forbidden();
    if (complaint.status !== "NEW") {
      throw Errors.invalidTransition("Complaint can only be edited while status is NEW.");
    }

    if (body.equipmentId) {
      const equipment = await db.equipment.findUnique({ where: { id: body.equipmentId }, select: { id: true, customerId: true } });
      if (!equipment) throw Errors.badRequest("Equipment not found.");
      if (equipment.customerId !== complaint.customerId) throw Errors.badRequest("Equipment does not belong to this customer.");
    }

    const updated = await db.complaint.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.equipmentId !== undefined ? { equipmentId: body.equipmentId } : {}),
      },
      include: COMPLAINT_DETAIL_INCLUDE,
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "COMPLAINT_UPDATED",
      resourceType: "COMPLAINT", resourceId: id,
      metadata: { code: complaint.code, fields: Object.keys(body) },
    });
    return ok(updated);
  },
  { permission: PERMISSIONS.complaints_read }
);
