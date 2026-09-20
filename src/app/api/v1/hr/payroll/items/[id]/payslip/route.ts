// MOHD.HMS ENTERPRISE — Secure stored-payslip download (spec §34/§37).
//
// Access is enforced SERVER-SIDE (§30 — never frontend hiding):
//   • the employee's own linked account, OR
//   • a caller holding payroll.read (HR/Finance/admins).
// Everyone else — including other employees — gets a 404-style denial; every
// download is audited. The PDF is streamed from MinIO through this RBAC route;
// object URLs are never public (§37).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";

const withId = (
  permission: Permission | null,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission: permission ?? undefined })(req);
  };
};

export const GET = withId(null, async (id, { user }) => {
  const item = await db.payrollItem.findUnique({
    where: { id },
    select: {
      employeeNo: true,
      employeeName: true,
      payslipObjectKey: true,
      payslipSizeBytes: true,
      employee: { select: { userId: true } },
      run: { select: { code: true, name: true } },
    },
  });
  if (!item) throw Errors.notFound("Payslip not found.");

  // §30 — owner or explicit payroll permission; anonymous/other employees denied.
  const isOwner = !!item.employee.userId && item.employee.userId === user.id;
  const canReadAll = roleCan(user.role, PERMISSIONS.payroll_read);
  if (!isOwner && !canReadAll) throw Errors.forbidden("You can only view your own payslip.");

  if (!item.payslipObjectKey) throw Errors.notFound("Payslip PDF has not been generated yet.");
  const obj = await storage.get(item.payslipObjectKey);
  if (!obj) throw Errors.notFound("Stored payslip file is missing from object storage.");

  await audit({
    actorId: user.id, actorEmail: user.email, action: "PAYSLIP_DOWNLOADED",
    resourceType: "PAYROLL_ITEM", resourceId: id,
    metadata: { run: item.run.code, employeeNo: item.employeeNo, byOwner: isOwner },
  });

  return new NextResponse(new Uint8Array(obj.buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="payslip-${item.employeeNo}-${item.run.code}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
});
