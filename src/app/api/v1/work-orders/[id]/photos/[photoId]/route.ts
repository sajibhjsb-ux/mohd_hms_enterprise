// MOHD.HMS ENTERPRISE — Delete one work-order evidence item.
// DELETE /api/v1/work-orders/[id]/photos/[photoId]
//   Allowed while the work order is editable. BEFORE evidence is deletable only
//   before work starts (supervisors/admins may correct it later); DURING/AFTER
//   evidence is deletable only while the work order is active. Object storage
//   and metadata are removed together — metadata is never deleted if the
//   object delete fails, so no orphaned evidence is left behind.
import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import { isAssignedTechnician, isSupervisorPlus } from "../../../_lib";

type Ctx = { req: NextRequest; user: SessionUser };

function withIds(fn: (id: string, photoId: string, ctx: Ctx) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string; photoId: string }> }) => {
    const { id, photoId } = await ctx.params;
    return handler((c) => fn(id, photoId, c), { permission: PERMISSIONS.work_orders_update })(req);
  };
}

export const DELETE = withIds(async (id, photoId, { user }) => {
  const wo = await db.workOrder.findUnique({
    where: { id },
    select: { id: true, code: true, status: true, technicianId: true },
  });
  if (!wo) throw Errors.notFound("Work order not found.");

  const isUpdater = roleCan(user.role, PERMISSIONS.work_orders_update);
  const isAssignedTech = await isAssignedTechnician(user, wo.technicianId);
  if (!isUpdater && !isAssignedTech) throw Errors.forbidden();

  const doc = await db.document.findFirst({
    where: { id: photoId, resourceType: "WORK_ORDER", resourceId: id, category: "WORK_ORDER" },
  });
  if (!doc) throw Errors.notFound("Evidence not found.");

  if (["COMPLETED", "CLOSED", "CANCELLED"].includes(wo.status)) {
    throw Errors.invalidTransition("Evidence is locked after the work order is submitted or closed.");
  }

  const phase = doc.label;
  if (phase === "BEFORE") {
    if (!["PENDING", "ACCEPTED"].includes(wo.status) && !isSupervisorPlus(user.role)) {
      throw Errors.invalidTransition("Before-work evidence can only be removed before work starts.");
    }
  } else if (!["IN_PROGRESS", "ON_HOLD"].includes(wo.status)) {
    throw Errors.invalidTransition("During/after-work evidence can only be removed while the work order is in progress.");
  }

  await storage.removeStrict(doc.storagePath);
  await db.document.delete({ where: { id: doc.id } });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "WO_EVIDENCE_DELETED",
    resourceType: "DOCUMENT",
    resourceId: doc.id,
    metadata: { workOrderCode: wo.code, phase, name: doc.name, sizeBytes: doc.sizeBytes },
  });

  return ok({ id: doc.id });
});
