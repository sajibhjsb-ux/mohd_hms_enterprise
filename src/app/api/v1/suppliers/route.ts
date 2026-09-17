// MOHD.HMS ENTERPRISE — Suppliers: list + create.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, nextNumber } from "@/lib/hms/services";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const where = q.search
      ? {
          OR: [
            { code: { contains: q.search } },
            { name: { contains: q.search } },
            { contactPerson: { contains: q.search } },
          ],
        }
      : {};

    const [rows, total] = await Promise.all([
      db.supplier.findMany({
        where,
        orderBy: { name: "asc" },
        skip: q.skip,
        take: q.take,
        include: { _count: { select: { items: true, purchaseOrders: true } } },
      }),
      db.supplier.count({ where }),
    ]);

    return okList(rows, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.purchases_read }
);

const supplierSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160),
  contactPerson: z.string().trim().max(120).optional(),
  email: z
    .string()
    .trim()
    .max(160)
    .refine((v) => v === "" || EMAIL_RE.test(v), "Enter a valid email address.")
    .optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(400).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, supplierSchema);

    const code = await nextNumber("SUP");
    const supplier = await db.supplier.create({
      data: {
        code,
        name: body.name,
        contactPerson: body.contactPerson ?? "",
        email: body.email ?? "",
        phone: body.phone ?? "",
        address: body.address ?? "",
        status: "ACTIVE",
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "SUPPLIER_CREATED",
      resourceType: "SUPPLIER",
      resourceId: supplier.id,
      metadata: { code: supplier.code, name: supplier.name },
    });

    return ok(supplier, 201);
  },
  { permission: PERMISSIONS.purchases_manage }
);
