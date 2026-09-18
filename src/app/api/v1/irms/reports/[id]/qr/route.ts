import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";

/**
 * Resolve the public origin: x-forwarded-proto + x-forwarded-host (behind the
 * gateway) with a localhost:3000 fallback for direct dev access.
 */
export function requestOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host")?.trim();
  if (host) return `${proto || "http"}://${host}`;
  return "http://localhost:3000";
}

/**
 * 16. GET /api/v1/irms/reports/[id]/qr — PNG QR encoding `${origin}/#/irms/reports/{id}`.
 * STAFF_READ, or the same portal authorization as the photos file route.
 * The QR never bypasses auth (§34) — RBAC still applies on arrival.
 */
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return handler(
    async ({ req: request, user }) => {
      const report = await db.inspectionReport.findUnique({
        where: { id },
        include: { project: { select: { customerId: true } } },
      });
      if (!report) throw Errors.notFound("Inspection report not found.");

      const staffAllowed = roleCan(user.role, PERMISSIONS.irms_read);
      const portalAllowed =
        !staffAllowed &&
        roleCan(user.role, PERMISSIONS.irms_portal) &&
        !!user.customerId &&
        user.customerId === report.project.customerId &&
        report.customerVisible &&
        (report.status === "APPROVED" || report.status === "ARCHIVED");
      if (!staffAllowed && !portalAllowed) throw Errors.notFound("Inspection report not found.");

      const origin = requestOrigin(request);
      const url = `${origin}/#/irms/reports/${id}`;
      const png = await QRCode.toBuffer(url, { width: 256, margin: 1, errorCorrectionLevel: "M" });

      return new NextResponse(new Uint8Array(png), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(png.length),
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
    { auth: true }
  )(req);
};
