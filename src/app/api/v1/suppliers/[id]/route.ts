// MOHD.HMS ENTERPRISE — Supplier detail / update / archive.
// Next 16 dynamic route: params arrive as a Promise.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS } from "@/lib/hms/constants";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";

function withId(
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const supplierSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160).optional(),
  contactPerson: z.string().trim().max(120).optional(),
  email: z
    .string()
    .trim()
    .max(160)
    .refine((v) => v === "" || EMAIL_RE.test(v), "Enter a valid email address.")
    .optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(400).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const GET = withId(PERMISSIONS.purchases_read, async (id) => {
  const supplier = await db.supplier.findUnique({
    where: { id },
    include: { _count: { select: { items: true, purchaseOrders: true } } },
  });
  if (!supplier) throw Errors.notFound("Supplier not found.");
  return ok(supplier);
});

export const PATCH = withId(PERMISSIONS.purchases_manage, async (id, { req, user }) => {
  const body = await parseBody(req, supplierSchema);
  const supplier = await db.supplier.findUnique({ where: { id } });
  if (!supplier) throw Errors.notFound("Supplier not found.");

  const updated = await db.supplier.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.contactPerson !== undefined ? { contactPerson: body.contactPerson } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "SUPPLIER_UPDATED",
    resourceType: "SUPPLIER",
    resourceId: id,
    metadata: { code: updated.code },
  });

  return ok(updated);
});

export const DELETE = withId(PERMISSIONS.purchases_manage, async (id, { user }) => {
  const supplier = await db.supplier.findUnique({ where: { id } });
  if (!supplier) throw Errors.notFound("Supplier not found.");

  const [itemCount, poCount, expenseCount] = await Promise.all([
    db.inventoryItem.count({ where: { supplierId: id } }),
    db.purchaseOrder.count({ where: { supplierId: id } }),
    db.expense.count({ where: { supplierId: id } }),
  ]);

  if (itemCount > 0 || poCount > 0 || expenseCount > 0) {
    // Referenced by business records — soft archive instead of hard delete.
    const archived = await db.supplier.update({ where: { id }, data: { status: "INACTIVE" } });
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "SUPPLIER_ARCHIVED",
      resourceType: "SUPPLIER",
      resourceId: id,
      metadata: { code: supplier.code, reason: "referenced by items, POs or expenses" },
    });
    return ok({ archived: true, supplier: archived });
  }

  const deleted = await db.supplier.delete({ where: { id } });
  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "SUPPLIER_DELETED",
    resourceType: "SUPPLIER",
    resourceId: id,
    metadata: { code: supplier.code },
  });
  return ok({ deleted: true, supplier: deleted });
});
