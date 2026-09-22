// MOHD.HMS ENTERPRISE — Customers module API (list / create).
// Customers role can only ever see their own customer record.

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ciContains, normalizeSearchTerm } from "@/lib/hms/text-search";
import { db } from "@/lib/db";
import { handler, ok, okList, Errors, parseBody, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { isStaff } from "@/lib/hms/rbac";
import { nextNumber, audit, notifyRole } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { hashPassword, validatePasswordStrength } from "@/lib/hms/auth";
import { clientIp } from "@/lib/hms/rate-limit";

const CUSTOMER_SELECT = {
  id: true,
  code: true,
  companyName: true,
  contactPerson: true,
  email: true,
  phone: true,
  address: true,
  city: true,
  country: true,
  status: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  portalUser: { select: { id: true, email: true, name: true, status: true } },
  _count: { select: { equipment: true, complaints: true, invoices: true } },
} satisfies Prisma.CustomerSelect;

const SORT_FIELDS = ["createdAt", "companyName", "code", "status"] as const;

export const GET = handler(
  async ({ req, user }) => {
    const q = listQuery(req);
    const where: Prisma.CustomerWhereInput = {};

    // Customer portal users are scoped to their own record.
    if (!isStaff(user.role)) {
      where.id = user.customerId ?? "none";
    } else {
      if (q.customerId) where.id = q.customerId;
      if (q.status) where.status = q.status.toUpperCase();
      if (q.search) {
        const term = ciContains(normalizeSearchTerm(q.search));
        where.OR = [
          { companyName: term },
          { contactPerson: term },
          { email: term },
          { code: term },
        ];
      }
    }

    const sortField = (SORT_FIELDS as readonly string[]).includes(q.sort) ? (q.sort as (typeof SORT_FIELDS)[number]) : "createdAt";

    const [items, total] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: { [sortField]: q.dir },
        skip: q.skip,
        take: q.take,
        select: CUSTOMER_SELECT,
      }),
      db.customer.count({ where }),
    ]);

    return okList(items, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.customers_read }
);

const createSchema = z.object({
  // Company name is OPTIONAL for customers — an account may be an individual,
  // homeowner, tenant or corporate contact (spec §5/§27).
  companyName: z.string().trim().max(200).optional().default(""),
  contactPerson: z.string().min(1, "Contact person is required.").max(120),
  email: z.string().email("Enter a valid email address.").max(200),
  phone: z.string().min(1, "Phone is required.").max(40),
  address: z.string().max(500).optional(),
  city: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  portalEmail: z.union([z.string().email("Enter a valid portal email address."), z.literal("")]).optional(),
  portalPassword: z.string().max(200).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const ip = clientIp(req);

    let portalUserEmail: string | null = null;
    if (body.portalEmail && body.portalPassword) {
      const strengthError = validatePasswordStrength(body.portalPassword);
      if (strengthError) throw Errors.badRequest(strengthError, [{ path: "portalPassword", message: strengthError }]);
      const taken = await db.user.findUnique({ where: { email: body.portalEmail.toLowerCase() }, select: { id: true } });
      if (taken) throw Errors.conflict("A user account with this portal email already exists.");
      portalUserEmail = body.portalEmail.toLowerCase();
    }

    const code = await nextNumber("CUS");

    const customer = await db.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          code,
          companyName: body.companyName.trim(),
          contactPerson: body.contactPerson.trim(),
          email: body.email.toLowerCase().trim(),
          phone: body.phone.trim(),
          address: body.address?.trim() ?? "",
          city: body.city?.trim() ?? "",
          ...(body.country?.trim() ? { country: body.country.trim() } : {}),
          notes: body.notes?.trim() ?? "",
        },
      });

      if (portalUserEmail && body.portalPassword) {
        await tx.user.create({
          data: {
            email: portalUserEmail,
            passwordHash: await hashPassword(body.portalPassword),
            name: created.contactPerson,
            role: "CUSTOMER",
            status: "ACTIVE",
            customerId: created.id,
            createdBy: user.id,
          },
        });
      }
      return tx.customer.findUniqueOrThrow({ where: { id: created.id }, select: CUSTOMER_SELECT });
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "CUSTOMER_CREATED",
      resourceType: "CUSTOMER",
      resourceId: customer.id,
      metadata: { code: customer.code, companyName: customer.companyName, portalCreated: !!portalUserEmail },
      ip,
    });

    await notifyRole("ADMIN", {
      title: "New customer onboarded",
      message: `${customer.companyName} (${customer.code}) was added by ${user.name}.`,
      type: "SUCCESS",
      resourceType: "CUSTOMER",
      resourceId: customer.id,
    });

    // Realtime: customer records appear live for staff + that customer's portal.
    await emit({ type: EVENT_TYPES.CUSTOMER_UPDATED, resourceType: "CUSTOMER", resourceId: customer.id, payload: { code: customer.code, companyName: customer.companyName }, actorType: "USER", actorId: user.id });
    return ok(customer, 201);
  },
  { permission: PERMISSIONS.customers_create }
);
