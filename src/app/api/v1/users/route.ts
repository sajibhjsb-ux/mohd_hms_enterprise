// MOHD.HMS ENTERPRISE — Users module API (list / create).
// Never returns passwordHash. Customer portal users are hidden by default
// (pass includeCustomers=1 to see them). SUPER_ADMIN creation is restricted.

import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, okList, Errors, parseBody, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { nextNumber, audit, notifyRole } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { hashPassword, validatePasswordStrength } from "@/lib/hms/auth";
import { clientIp } from "@/lib/hms/rate-limit";
import { createCustomerRecord, newCustomerCode } from "@/lib/hms/customer-profile";

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  customer: { select: { id: true, companyName: true, code: true, contactPerson: true } },
  technicianProfile: { select: { id: true, employeeNo: true, specialty: true, status: true } },
  _count: { select: { sessions: true } },
} satisfies Prisma.UserSelect;

const SORT_FIELDS = ["createdAt", "name", "email", "role", "status"] as const;

const USER_ROLES = ["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "CUSTOMER", "FINANCE", "HR"] as const;

export const GET = handler(
  async ({ req, user }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const includeCustomers = sp.get("includeCustomers") === "1";
    const roleParam = (sp.get("role") ?? "").trim();

    const where: Prisma.UserWhereInput = {};
    if (!includeCustomers) where.role = { not: "CUSTOMER" };
    if (roleParam) where.role = roleParam.toUpperCase();
    if (q.status) where.status = q.status.toUpperCase();
    if (q.customerId) where.customerId = q.customerId;
    if (q.search) {
      where.OR = [
        { name: { contains: q.search } },
        { email: { contains: q.search } },
      ];
    }

    const sortField = (SORT_FIELDS as readonly string[]).includes(q.sort) ? (q.sort as (typeof SORT_FIELDS)[number]) : "createdAt";

    const [items, total] = await Promise.all([
      db.user.findMany({
        where,
        orderBy: { [sortField]: q.dir },
        skip: q.skip,
        take: q.take,
        select: USER_SELECT,
      }),
      db.user.count({ where }),
    ]);

    return okList(items, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.users_read }
);

const createSchema = z.object({
  email: z.string().email("Enter a valid email address.").max(200),
  name: z.string().min(1, "Name is required.").max(120),
  password: z.string().min(1, "Password is required.").max(200),
  role: z.enum(USER_ROLES),
  phone: z.string().max(40).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const ip = clientIp(req);

    // Only SUPER_ADMIN may mint another SUPER_ADMIN.
    if (body.role === "SUPER_ADMIN" && user.role !== "SUPER_ADMIN") {
      throw Errors.forbidden("Only a SUPER_ADMIN can create SUPER_ADMIN accounts.");
    }

    const strengthError = validatePasswordStrength(body.password);
    if (strengthError) throw Errors.badRequest(strengthError, [{ path: "password", message: strengthError }]);

    const email = body.email.toLowerCase().trim();
    const taken = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (taken) throw Errors.conflict("A user account with this email already exists.");

    const passwordHash = await hashPassword(body.password);
    // Pre-allocate numbers OUTSIDE the transaction — nextNumber()
    // writes via the global db client, which would deadlock on SQLite inside one.
    const tecEmployeeNo = body.role === "TECHNICIAN" ? await nextNumber("TEC") : null;
    const cusCode = body.role === "CUSTOMER" ? await newCustomerCode() : null;

    const created = await db.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email,
          passwordHash,
          name: body.name.trim(),
          phone: body.phone?.trim() || null,
          role: body.role,
          status: "ACTIVE",
          createdBy: user.id,
        },
      });
      // Every technician gets a profile with an employee number.
      if (u.role === "TECHNICIAN" && tecEmployeeNo) {
        await tx.technicianProfile.create({
          data: {
            userId: u.id,
            employeeNo: tecEmployeeNo,
            specialty: "GENERAL",
            skills: "",
            hourlyRateCents: 0,
            status: "AVAILABLE",
          },
        });
      }
      // Every CUSTOMER user gets the canonical Customer identity in the same
      // transaction — a customer account without a customer record would be
      // unclassifiable (invisible in Customers, unscoped, unable to file jobs).
      // Company name is optional; the customer completes mobile/address via
      // profile onboarding.
      if (u.role === "CUSTOMER" && cusCode) {
        const customer = await createCustomerRecord(tx, cusCode, {
          name: u.name,
          email: u.email,
          phone: u.phone ?? undefined,
        });
        return tx.user.update({ where: { id: u.id }, data: { customerId: customer.id } });
      }
      return u;
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "USER_CREATED",
      resourceType: "USER",
      resourceId: created.id,
      metadata: { email: created.email, name: created.name, role: created.role },
      ip,
    });

    await notifyRole("ADMIN", {
      title: "New user account created",
      message: `${created.name} (${created.email}) was added as ${created.role} by ${user.name}.`,
      type: "INFO",
      resourceType: "USER",
      resourceId: created.id,
    });

    const { passwordHash: _omit, ...safe } = created;
    // Realtime (STEP 11/49): user admin views + the affected user update live.
    await emit({ type: EVENT_TYPES.USER_UPDATED, resourceType: "USER", resourceId: created.id, payload: { email: created.email, name: created.name }, actorType: "USER", actorId: user.id });
    return ok(safe, 201);
  },
  { permission: PERMISSIONS.users_create }
);
