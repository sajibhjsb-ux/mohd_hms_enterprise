// MOHD.HMS ENTERPRISE — Purchase order detail + draft editing.
// Next 16 dynamic route: params arrive as a Promise.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toCents } from "@/lib/hms/format";
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

const includeDetail = {
  supplier: { select: { id: true, name: true, code: true, contactPerson: true, email: true, phone: true } },
  items: { include: { item: { select: { id: true, sku: true, name: true, unit: true } } } },
} as const;

export const GET = withId(PERMISSIONS.purchases_read, async (id) => {
  const po = await db.purchaseOrder.findUnique({ where: { id }, include: includeDetail });
  if (!po) throw Errors.notFound("Purchase order not found.");
  return ok(po);
});

const poItemSchema = z.object({
  itemId: z.string().trim().nullable().optional(),
  description: z.string().trim().min(1, "Description is required").max(240),
  quantity: z.coerce.number().positive("Quantity must be greater than zero."),
  unitCost: z.coerce.number().min(0, "Unit cost cannot be negative."),
});

const patchSchema = z.object({
  supplierId: z.string().trim().min(1).optional(),
  expectedDate: z.string().trim().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  items: z.array(poItemSchema).min(1, "At least one item is required.").optional(),
});

function parseDateInput(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export const PATCH = withId(PERMISSIONS.purchases_manage, async (id, { req, user }) => {
  const body = await parseBody(req, patchSchema);

  const po = await db.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
  if (!po) throw Errors.notFound("Purchase order not found.");
  if (po.status !== "DRAFT") throw Errors.invalidTransition("Only draft purchase orders can be edited.");

  let supplierId = po.supplierId;
  if (body.supplierId && body.supplierId !== po.supplierId) {
    const supplier = await db.supplier.findUnique({ where: { id: body.supplierId } });
    if (!supplier) throw Errors.badRequest("Supplier not found.");
    supplierId = body.supplierId;
  }

  const expectedDate = body.expectedDate !== undefined ? parseDateInput(body.expectedDate) : po.expectedDate;
  if (body.expectedDate && !expectedDate) throw Errors.badRequest("Invalid expected date.");

  let subtotalCents = po.subtotalCents;
  let taxCents = po.taxCents;
  let totalCents = po.totalCents;

  const updated = await db.$transaction(async (tx) => {
    if (body.items) {
      const itemIds = body.items.map((i) => i.itemId).filter((v): v is string => !!v);
      if (itemIds.length > 0) {
        const found = await tx.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true } });
        const foundIds = new Set(found.map((f) => f.id));
        if (itemIds.some((iid) => !foundIds.has(iid))) {
          throw Errors.badRequest("One of the selected inventory items no longer exists.");
        }
      }

      const lines = body.items.map((i) => {
        const unitCostCents = toCents(i.unitCost);
        return {
          itemId: i.itemId || null,
          description: i.description,
          quantity: i.quantity,
          unitCostCents,
          totalCents: Math.round(i.quantity * unitCostCents),
        };
      });
      subtotalCents = lines.reduce((s, l) => s + l.totalCents, 0);
      taxCents = Math.round(subtotalCents * 0.06);
      totalCents = subtotalCents + taxCents;

      await tx.purchaseItem.deleteMany({ where: { poId: id } });
      await tx.purchaseItem.createMany({
        data: lines.map((l) => ({ ...l, poId: id })),
      });
    }

    return tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId,
        expectedDate,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        subtotalCents,
        taxCents,
        totalCents,
      },
      include: includeDetail,
    });
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "PO_UPDATED",
    resourceType: "PURCHASE_ORDER",
    resourceId: id,
    metadata: { code: po.code, totalCents: updated.totalCents },
  });

  return ok(updated);
});
