import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { readVariantFile } from "@/lib/hms/irms/storage";

/**
 * 9c. GET /api/v1/irms/signatures/[id]/file — streams the PNG signature.
 * Same authorization as the photos file route: STAFF_READ, or the owning
 * customer's portal user when the report is APPROVED/ARCHIVED + customerVisible.
 */
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return handler(
    async ({ user }) => {
      const signature = await db.inspectionSignature.findUnique({
        where: { id },
        include: { report: { include: { project: { select: { customerId: true } } } } },
      });
      if (!signature) throw Errors.notFound("Signature not found.");

      const staffAllowed = roleCan(user.role, PERMISSIONS.irms_read);
      const portalAllowed =
        !staffAllowed &&
        roleCan(user.role, PERMISSIONS.irms_portal) &&
        !!user.customerId &&
        user.customerId === signature.report.project.customerId &&
        signature.report.customerVisible &&
        (signature.report.status === "APPROVED" || signature.report.status === "ARCHIVED");
      if (!staffAllowed && !portalAllowed) throw Errors.notFound("Signature not found.");

      const file = await readVariantFile(signature.storagePath);
      if (!file) throw Errors.notFound("Signature file not found.");

      return new NextResponse(Buffer.from(file.buffer), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(file.buffer.length),
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
    { auth: true }
  )(req);
};
