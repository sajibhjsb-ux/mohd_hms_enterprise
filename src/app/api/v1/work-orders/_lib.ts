// MOHD.HMS ENTERPRISE — Work Orders module shared helpers (not a route file).
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";

export const WO_INCLUDE = {
  customer: { select: { id: true, companyName: true, contactPerson: true } },
  equipment: { select: { id: true, name: true, assetTag: true } },
  technician: { select: { id: true, user: { select: { id: true, name: true } } } },
  complaint: { select: { id: true, code: true } },
  pmTask: { select: { id: true, code: true, planId: true } },
} satisfies Prisma.WorkOrderInclude;

export const WO_DETAIL_INCLUDE = {
  ...WO_INCLUDE,
  customer: { select: { id: true, companyName: true, contactPerson: true, portalUser: { select: { id: true, name: true, email: true } } } },
  checklist: { orderBy: { sortOrder: "asc" } },
  materials: {
    orderBy: { id: "asc" },
    include: {
      inventoryItem: {
        select: { id: true, name: true, unit: true, sku: true, stockQty: true, reservedQty: true, avgCostCents: true, stockType: true },
      },
    },
  },
} satisfies Prisma.WorkOrderInclude;

export type WorkOrderLike = { customerId: string; technicianId: string | null };

/** Detail/transition access: customers see own; technicians only WOs assigned to their profile; staff all. */
export async function assertViewWorkOrder(user: SessionUser, wo: WorkOrderLike): Promise<void> {
  if (user.role === "CUSTOMER") {
    if (wo.customerId !== user.customerId) throw Errors.forbidden();
    return;
  }
  if (user.role === "TECHNICIAN") {
    const profileId = await technicianProfileIdFor(user.id);
    if (wo.technicianId !== profileId) throw Errors.forbidden();
  }
}

export async function technicianProfileIdFor(userId: string): Promise<string | null> {
  const profile = await db.technicianProfile.findUnique({ where: { userId }, select: { id: true } });
  return profile?.id ?? null;
}

/** True when the caller is the technician currently assigned to the work order. */
export async function isAssignedTechnician(user: SessionUser, technicianId: string | null): Promise<boolean> {
  if (!technicianId) return false;
  const profileId = await technicianProfileIdFor(user.id);
  return !!profileId && profileId === technicianId;
}

/** Supervisor-or-above (never the technician role) — used for "or supervisor+ with …" rules. */
export function isSupervisorPlus(role: string): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN" || role === "SUPERVISOR";
}

/** Recompute labour/materials/grand totals from current rows and persist. */
export async function recalcWorkOrderTotals(workOrderId: string): Promise<{ materialsTotalCents: number; labourTotalCents: number; totalCents: number }> {
  const wo = await db.workOrder.findUnique({
    where: { id: workOrderId },
    select: { labourHours: true, labourRateCents: true, materials: { select: { totalCents: true }, orderBy: { id: "asc" } } },
  });
  const materialsTotalCents = wo ? wo.materials.reduce((s, m) => s + m.totalCents, 0) : 0;
  const labourTotalCents = wo ? Math.round(wo.labourHours * wo.labourRateCents) : 0;
  const totalCents = labourTotalCents + materialsTotalCents;
  await db.workOrder.update({ where: { id: workOrderId }, data: { materialsTotalCents, labourTotalCents, totalCents } });
  return { materialsTotalCents, labourTotalCents, totalCents };
}

export function assertWoTransition(to: string, from: string, map: Record<string, string[]>): void {
  const allowed = map[from] ?? [];
  if (!allowed.includes(to)) throw Errors.invalidTransition(`${from} → ${to} is not allowed`);
}

export type PrismaWo = Prisma.WorkOrderWhereInput;
