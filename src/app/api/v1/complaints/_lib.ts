// MOHD.HMS ENTERPRISE — Complaints module shared helpers (not a route file).
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";

export const COMPLAINT_INCLUDE = {
  customer: { select: { id: true, companyName: true } },
  equipment: { select: { id: true, name: true, assetTag: true } },
  assignedTechnician: { select: { id: true, user: { select: { id: true, name: true } } } },
} satisfies Prisma.ComplaintInclude;

export const COMPLAINT_DETAIL_INCLUDE = {
  ...COMPLAINT_INCLUDE,
  customer: { select: { id: true, companyName: true, contactPerson: true, email: true, phone: true, portalUser: { select: { id: true, name: true, email: true } } } },
  workOrders: {
    select: { id: true, code: true, title: true, status: true, technician: { select: { id: true, user: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" },
  },
  statusHistory: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.ComplaintInclude;

/** Role-based visibility: customers see own; technicians see assigned-to-profile or self-created; staff see all. */
export async function complaintScopeWhere(user: SessionUser): Promise<Prisma.ComplaintWhereInput> {
  if (user.role === "CUSTOMER") {
    return { customerId: user.customerId ?? "none" };
  }
  if (user.role === "TECHNICIAN") {
    const profile = await db.technicianProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
    return { OR: [{ assignedTechnicianId: profile?.id ?? "none" }, { createdById: user.id }] };
  }
  return {};
}

export async function technicianProfileIdFor(userId: string): Promise<string | null> {
  const profile = await db.technicianProfile.findUnique({ where: { userId }, select: { id: true } });
  return profile?.id ?? null;
}

/** Detail/transition access: 404 when missing, 403 when out of the caller's scope. */
export function assertViewComplaint(
  user: SessionUser,
  complaint: { customerId: string; createdById: string | null; assignedTechnicianId: string | null },
  technicianProfileId: string | null
): void {
  if (user.role === "CUSTOMER") {
    if (complaint.customerId !== user.customerId) throw Errors.forbidden();
    return;
  }
  if (user.role === "TECHNICIAN") {
    const allowed = complaint.assignedTechnicianId === technicianProfileId || complaint.createdById === user.id;
    if (!allowed) throw Errors.forbidden();
  }
}
