// MOHD.HMS ENTERPRISE — Employees list & search API (§19).
// GET /api/v1/employees — list employees with optional server-side search.
// Supports: ?search= query across name/employeeNo/department/position
// Pagination via ?page= & ?pageSize=
// RBAC: employees.read gating (CUSTOMER role scoped to own customer).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, listQuery } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(
  async ({ req, user }) => {
    const q = listQuery(req);

    const where: Record<string, unknown> = {};
    // §44 — customers only see their own employee records.
    if (user.role === "CUSTOMER") {
      where.customerId = user.customerId ?? "__none__";
    }

    if (q.search) {
      where.OR = [
        { employeeNo: { contains: q.search } },
        { firstName: { contains: q.search } },
        { lastName: { contains: q.search } },
        { department: { contains: q.search } },
        { position: { contains: q.search } },
      ];
    }

    const [items, total] = await Promise.all([
      db.employee.findMany({
        where,
        orderBy: { lastName: "asc" },
        skip: q.skip,
        take: q.take,
        select: {
          id: true,
          employeeNo: true,
          firstName: true,
          lastName: true,
          department: true,
          position: true,
          user: { select: { id: true, email: true, name: true } },
        },
      }),
      db.employee.count({ where }),
    ]);

    return okList(items, {
      total,
      page: q.page,
      pageSize: q.pageSize,
    });
  },
  { permission: PERMISSIONS.employees_read }
);