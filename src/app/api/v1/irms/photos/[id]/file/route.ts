import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { readVariantFile } from "@/lib/hms/irms/storage";

/**
 * 8g. GET /api/v1/irms/photos/[id]/file?variant=thumb|display|original
 * Auth: STAFF_READ, OR portal user of the owning customer while the report is
 * APPROVED/ARCHIVED AND customerVisible (existence otherwise hidden → 404).
 */
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return handler(
    async ({ req: request, user }) => {
      const photo = await db.inspectionPhoto.findUnique({
        where: { id },
        include: { report: { include: { project: { select: { customerId: true } } } } },
      });
      if (!photo) throw Errors.notFound("Photo not found.");

      const staffAllowed = roleCan(user.role, PERMISSIONS.irms_read);
      const portalAllowed =
        !staffAllowed &&
        roleCan(user.role, PERMISSIONS.irms_portal) &&
        !!user.customerId &&
        user.customerId === photo.report.project.customerId &&
        photo.report.customerVisible &&
        (photo.report.status === "APPROVED" || photo.report.status === "ARCHIVED");
      if (!staffAllowed && !portalAllowed) throw Errors.notFound("Photo not found.");

      const variant = new URL(request.url).searchParams.get("variant") ?? "display";
      const rel =
        variant === "original"
          ? photo.storagePath
          : variant === "thumb"
            ? photo.thumbPath || photo.displayPath || photo.storagePath
            : photo.displayPath || photo.storagePath;

      const file = await readVariantFile(rel);
      if (!file) throw Errors.notFound("Photo file not found.");

      return new NextResponse(Buffer.from(file.buffer), {
        status: 200,
        headers: {
          "Content-Type": file.contentType,
          "Content-Length": String(file.buffer.length),
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
    { auth: true } // permission decided per-record above (staff vs portal)
  )(req);
};
