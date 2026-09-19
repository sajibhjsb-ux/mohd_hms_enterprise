// MOHD.HMS ENTERPRISE — Letter creation metadata (§31/§32).
//
//   GET /api/v1/hr/letters/meta[?templateId={id}]
//
// Returns the SAFE reference data the create-letter wizard needs:
//   - employees: only approved HR fields (name, no, position, department,
//     joinDate). Salary is included ONLY when the selected template declares a
//     SALARY field and only to authorized letter creators (§31).
//   - customers: company/contact/address for auto-population (§32).
//   - projects / quotations / work orders: minimal code+title pairs.

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { safeParseFields } from "@/lib/hms/letters/server";

export const GET = handler(
  async ({ req }) => {
    const templateId = new URL(req.url).searchParams.get("templateId") ?? "";

    const [employees, customers, projects, quotations, workOrders] = await Promise.all([
      db.employee.findMany({
        where: { status: { not: "TERMINATED" } },
        orderBy: [{ firstName: "asc" }],
        select: {
          id: true,
          employeeNo: true,
          firstName: true,
          lastName: true,
          position: true,
          departmentId: true,
          department: { select: { name: true } },
          joinDate: true,
          // salaryCents selected conditionally below (safe-fields policy §31)
          salaryCents: true,
        },
        take: 500,
      }),
      db.customer.findMany({
        orderBy: [{ companyName: "asc" }],
        select: { id: true, code: true, companyName: true, contactPerson: true, address: true, city: true },
        take: 500,
      }),
      db.irmsProject.findMany({
        orderBy: [{ name: "asc" }],
        select: { id: true, code: true, name: true },
        take: 300,
      }),
      db.quotation.findMany({
        orderBy: [{ createdAt: "desc" }],
        select: { id: true, code: true },
        take: 200,
      }),
      db.workOrder.findMany({
        orderBy: [{ createdAt: "desc" }],
        select: { id: true, code: true, title: true },
        take: 200,
      }),
    ]);

    // Salary exposure rule: only when the template actually has a SALARY field
    // (verification letters) — never in the general picker payload.
    let includeSalary = false;
    if (templateId) {
      const t = await db.letterTemplate.findUnique({ where: { id: templateId }, select: { fieldsJson: true } });
      includeSalary = safeParseFields(t?.fieldsJson ?? "").some((f) => f.key === "SALARY");
    }

    return ok({
      employees: employees.map((e) => ({
        id: e.id,
        employeeNo: e.employeeNo,
        name: `${e.firstName} ${e.lastName}`,
        position: e.position,
        department: e.department?.name ?? "",
        departmentId: e.departmentId,
        joinDate: e.joinDate?.toISOString() ?? null,
        salaryCents: includeSalary ? e.salaryCents : undefined,
      })),
      customers,
      projects,
      quotations,
      workOrders,
    });
  },
  { permission: PERMISSIONS.letters_create }
);
