// MOHD.HMS ENTERPRISE — Profile API (own profile only).
// GET   /api/v1/profile  (auth)  — user + technicianProfile / employee / customer context
// PATCH /api/v1/profile  (auth)  — update own name / phone only

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    ""
  );
}

export const GET = handler(async ({ user }) => {
  const me = await db.user.findUnique({
    where: { id: user.id },
    include: {
      technicianProfile: true,
      employee: { include: { department: true } },
      customer: true,
    },
  });
  if (!me) throw Errors.notFound("User not found.");

  return ok({
    user: {
      id: me.id,
      email: me.email,
      name: me.name,
      phone: me.phone,
      role: me.role,
      status: me.status,
      lastLoginAt: me.lastLoginAt?.toISOString() ?? null,
      createdAt: me.createdAt.toISOString(),
    },
    technicianProfile: me.technicianProfile
      ? {
          id: me.technicianProfile.id,
          employeeNo: me.technicianProfile.employeeNo,
          skills: me.technicianProfile.skills,
          specialty: me.technicianProfile.specialty,
          status: me.technicianProfile.status,
          hourlyRateCents: me.technicianProfile.hourlyRateCents,
        }
      : null,
    employee: me.employee
      ? {
          id: me.employee.id,
          employeeNo: me.employee.employeeNo,
          name: `${me.employee.firstName} ${me.employee.lastName}`.trim(),
          position: me.employee.position,
          department: me.employee.department?.name ?? null,
          email: me.employee.email,
          phone: me.employee.phone,
          joinDate: me.employee.joinDate?.toISOString() ?? null,
          status: me.employee.status,
        }
      : null,
    customer: me.customer
      ? {
          id: me.customer.id,
          code: me.customer.code,
          companyName: me.customer.companyName,
          contactPerson: me.customer.contactPerson,
          email: me.customer.email,
          phone: me.customer.phone,
        }
      : null,
  });
});

const patchSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters.").max(80).optional(),
    phone: z.string().trim().max(30).optional(),
  })
  .refine((v) => v.name !== undefined || v.phone !== undefined, "Nothing to update.");

export const PATCH = handler(async ({ req, user }) => {
  const body = await parseBody(req, patchSchema);

  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone === "" ? null : body.phone } : {}),
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "PROFILE_UPDATED",
    resourceType: "User",
    resourceId: user.id,
    metadata: { fields: Object.keys(body) },
    ip: clientIp(req),
  });

  return ok({
    id: updated.id,
    email: updated.email,
    name: updated.name,
    phone: updated.phone,
    role: updated.role,
  });
});
