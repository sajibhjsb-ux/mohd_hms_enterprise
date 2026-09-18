import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

/**
 * 13. GET /api/v1/irms/meta (STAFF_READ) — selector payloads for the report
 * builder: projects / workOrders / equipment / customers / inspectors.
 */
export const GET = handler(
  async () => {
    const [projects, workOrders, equipment, customers, inspectors] = await Promise.all([
      db.irmsProject.findMany({
        take: 500,
        orderBy: { name: "asc" },
        select: {
          id: true,
          code: true,
          name: true,
          customerId: true,
          customer: { select: { companyName: true } },
          siteLocation: true,
        },
      }),
      db.workOrder.findMany({
        take: 500,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          code: true,
          title: true,
          customerId: true,
          description: true,
          priority: true,
          status: true,
          equipmentId: true,
          equipment: { select: { name: true, assetTag: true } },
          customer: { select: { companyName: true } },
          technician: { select: { user: { select: { name: true } } } },
        },
      }),
      db.equipment.findMany({
        take: 500,
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          assetTag: true,
          serialNumber: true,
          manufacturer: true,
          model: true,
          category: true,
          customerId: true,
          status: true,
          location: { select: { name: true } },
        },
      }),
      db.customer.findMany({ take: 500, orderBy: { companyName: "asc" }, select: { id: true, companyName: true } }),
      db.technicianProfile.findMany({
        where: { user: { status: "ACTIVE" } },
        orderBy: { employeeNo: "asc" },
        select: { id: true, employeeNo: true, user: { select: { name: true } } },
      }),
    ]);

    return ok({
      projects: projects.map((p) => ({ ...p, customerName: p.customer?.companyName ?? null })),
      workOrders,
      equipment,
      customers,
      inspectors: inspectors.map((i) => ({ id: i.id, employeeNo: i.employeeNo, name: i.user.name })),
    });
  },
  { permission: PERMISSIONS.irms_read }
);
