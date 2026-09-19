// MOHD.HMS ENTERPRISE — Customers module API (detail / update / delete).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { isStaff } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import { audit, notify } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { clientIp } from "@/lib/hms/rate-limit";

/**
 * Next.js 16 App Router: dynamic route params arrive as a Promise in the 2nd
 * handler argument. `handler()` only forwards the request, so we bridge here:
 * resolve params first, then delegate to handler() for auth/RBAC/error handling.
 */
const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

/** Customers may only access their own record. */
function assertScope(id: string, user: SessionUser) {
  if (!isStaff(user.role) && user.customerId !== id) throw Errors.notFound("Customer not found.");
}

export const GET = withId(PERMISSIONS.customers_read, async (id, { user }) => {
  assertScope(id, user);

  const customer = await db.customer.findUnique({
    where: { id },
    include: {
      portalUser: { select: { id: true, email: true, name: true, status: true, lastLoginAt: true } },
      _count: { select: { equipment: true, complaints: true, invoices: true, workOrders: true, quotations: true, payments: true } },
      complaints: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, code: true, title: true, status: true, priority: true, createdAt: true },
      },
      invoices: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, code: true, totalCents: true, paidCents: true, status: true, invoiceDate: true },
      },
    },
  });
  if (!customer) throw Errors.notFound("Customer not found.");

  return ok(customer);
});

const updateSchema = z.object({
  // Company name is OPTIONAL for customers — empty string clears it (spec §5/§27).
  companyName: z.string().trim().max(200).optional(),
  contactPerson: z.string().min(1).max(120).optional(),
  email: z.string().email("Enter a valid email address.").max(200).optional(),
  phone: z.string().min(1).max(40).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const PATCH = withId(PERMISSIONS.customers_update, async (id, { req, user }) => {
  assertScope(id, user);
  const body = await parseBody(req, updateSchema);
  const ip = clientIp(req);

  const existing = await db.customer.findUnique({ where: { id }, select: { id: true, code: true, companyName: true } });
  if (!existing) throw Errors.notFound("Customer not found.");

  if (body.email) {
    const dup = await db.customer.findFirst({ where: { email: body.email.toLowerCase(), id: { not: id } }, select: { id: true } });
    if (dup) throw Errors.conflict("Another customer already uses this email.");
  }

  const customer = await db.customer.update({
    where: { id },
    data: {
      ...(body.companyName !== undefined ? { companyName: body.companyName.trim() } : {}),
      ...(body.contactPerson !== undefined ? { contactPerson: body.contactPerson.trim() } : {}),
      ...(body.email !== undefined ? { email: body.email.toLowerCase().trim() } : {}),
      ...(body.phone !== undefined ? { phone: body.phone.trim() } : {}),
      ...(body.address !== undefined ? { address: body.address.trim() } : {}),
      ...(body.city !== undefined ? { city: body.city.trim() } : {}),
      ...(body.country !== undefined ? { country: body.country.trim() } : {}),
      ...(body.notes !== undefined ? { notes: body.notes.trim() } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "CUSTOMER_UPDATED",
    resourceType: "CUSTOMER",
    resourceId: id,
    metadata: { code: existing.code, fields: Object.keys(body) },
    ip,
  });

  // Realtime: customer edits propagate live to staff + that customer's portal.
  await emit({ type: EVENT_TYPES.CUSTOMER_UPDATED, resourceType: "CUSTOMER", resourceId: id, payload: { code: existing.code, fields: Object.keys(body) }, actorType: "USER", actorId: user.id });
  return ok(customer);
});

export const DELETE = withId(PERMISSIONS.customers_delete, async (id, { req, user }) => {
  const ip = clientIp(req);

  const existing = await db.customer.findUnique({
    where: { id },
    select: {
      id: true, code: true, companyName: true, status: true,
      _count: { select: { equipment: true, complaints: true, invoices: true } },
    },
  });
  if (!existing) throw Errors.notFound("Customer not found.");

  const hasHistory =
    existing._count.equipment > 0 || existing._count.complaints > 0 || existing._count.invoices > 0;

  if (hasHistory) {
    // Soft delete: keep financial/maintenance history intact.
    if (existing.status === "INACTIVE") {
      throw Errors.conflict("Customer is already inactive and has linked records.");
    }
    const customer = await db.customer.update({ where: { id }, data: { status: "INACTIVE" } });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "CUSTOMER_DEACTIVATED",
      resourceType: "CUSTOMER",
      resourceId: id,
      metadata: { code: existing.code, reason: "has_linked_records", counts: existing._count },
      ip,
    });

    // Notify the customer's portal user, if any.
    const portal = await db.user.findUnique({ where: { customerId: id }, select: { id: true } });
    if (portal) {
      await notify({
        userId: portal.id,
        title: "Account deactivated",
        message: `Your portal account was deactivated. Please contact Mohd HMS support for assistance.`,
        type: "WARNING",
        resourceType: "CUSTOMER",
        resourceId: id,
      });
    }

    return ok({ ...customer, softDeleted: true });
  }

  // No linked records — safe to hard delete. The linked portal user (if any)
  // has no purpose without the customer and is removed along with it
  // (sessions/notifications cascade).
  const portal = await db.user.findUnique({ where: { customerId: id }, select: { id: true, email: true } });
  await db.$transaction(async (tx) => {
    if (portal) await tx.user.delete({ where: { id: portal.id } });
    await tx.customer.delete({ where: { id } });
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "CUSTOMER_DELETED",
    resourceType: "CUSTOMER",
    resourceId: id,
    metadata: { code: existing.code, companyName: existing.companyName, portalRemoved: portal?.email ?? null },
    ip,
  });

  return ok({ id, deleted: true });
});
