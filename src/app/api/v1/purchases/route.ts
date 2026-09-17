// MOHD.HMS ENTERPRISE — Purchase orders: list + create.
// Totals are always computed server-side: subtotal = Σ round(qty × unitCostCents),
// tax = round(subtotal × 0.06), total = subtotal + tax. Money = integer cents.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";

function parseDateInput(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const supplierId = (sp.get("supplierId") ?? "").trim();

    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(q.search
        ? {
            OR: [{ code: { contains: q.search } }, { supplier: { name: { contains: q.search } } }],
          }
        : {}),
    };

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [rows, total, awaiting, approvedOpen, receivedThisMonth] = await Promise.all([
      db.purchaseOrder.findMany({
        where,
        orderBy: { orderDate: "desc" },
        skip: q.skip,
        take: q.take,
        include: {
          supplier: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
      }),
      db.purchaseOrder.count({ where }),
      db.purchaseOrder.count({ where: { status: "PENDING_APPROVAL" } }),
      db.purchaseOrder.count({ where: { status: { in: ["APPROVED", "PARTIALLY_RECEIVED"] } } }),
      db.purchaseOrder.count({ where: { status: "RECEIVED", receivedAt: { gte: monthStart } } }),
    ]);

    const stats = { awaitingApproval: awaiting, approvedOpen, receivedThisMonth };

    return okList(rows, { ...pagedMeta(q.page, q.pageSize, total), stats });
  },
  { permission: PERMISSIONS.purchases_read }
);

const poItemSchema = z.object({
  itemId: z.string().trim().nullable().optional(),
  description: z.string().trim().min(1, "Description is required").max(240),
  quantity: z.coerce.number().positive("Quantity must be greater than zero."),
  unitCost: z.coerce.number().min(0, "Unit cost cannot be negative."),
});

const createSchema = z.object({
  supplierId: z.string().trim().min(1, "Supplier is required"),
  orderDate: z.string().trim().optional(),
  expectedDate: z.string().trim().optional().nullable(),
  notes: z.string().trim().max(2000).optional(),
  items: z.array(poItemSchema).min(1, "At least one item is required."),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    const supplier = await db.supplier.findUnique({ where: { id: body.supplierId } });
    if (!supplier) throw Errors.badRequest("Supplier not found.");
    if (supplier.status !== "ACTIVE") throw Errors.badRequest("Supplier is not active.");

    const orderDate = parseDateInput(body.orderDate) ?? new Date();
    const expectedDate = parseDateInput(body.expectedDate);
    if (body.expectedDate && !expectedDate) throw Errors.badRequest("Invalid expected date.");

    const itemIds = body.items.map((i) => i.itemId).filter((v): v is string => !!v);
    if (itemIds.length > 0) {
      const found = await db.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true } });
      const foundIds = new Set(found.map((f) => f.id));
      const missing = itemIds.find((id) => !foundIds.has(id));
      if (missing) throw Errors.badRequest("One of the selected inventory items no longer exists.");
    }

    const lines = body.items.map((i) => {
      const unitCostCents = Math.round(i.unitCost * 100);
      return {
        itemId: i.itemId || null,
        description: i.description,
        quantity: i.quantity,
        unitCostCents,
        totalCents: Math.round(i.quantity * unitCostCents),
      };
    });
    const subtotalCents = lines.reduce((s, l) => s + l.totalCents, 0);
    const taxCents = Math.round(subtotalCents * 0.06);
    const totalCents = subtotalCents + taxCents;

    const code = await nextNumber("PO");
    const po = await db.purchaseOrder.create({
      data: {
        code,
        supplierId: body.supplierId,
        orderDate,
        expectedDate,
        status: "DRAFT",
        subtotalCents,
        taxCents,
        totalCents,
        notes: body.notes ?? "",
        items: { create: lines },
      },
      include: { items: true, supplier: { select: { id: true, name: true } } },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PO_CREATED",
      resourceType: "PURCHASE_ORDER",
      resourceId: po.id,
      metadata: { code: po.code, totalCents, itemCount: lines.length },
    });

    return ok(po, 201);
  },
  { permission: PERMISSIONS.purchases_manage }
);
