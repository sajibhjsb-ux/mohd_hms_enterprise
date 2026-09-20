// MOHD.HMS ENTERPRISE — Work order checklist photo streaming (AI checklist spec §33/§67).
// GET /api/v1/work-orders/[id]/photos/[photoId]/file — the ONLY way to read the
// bytes. The bucket is private: every download passes auth + RBAC here.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage } from "@/lib/hms/storage";
import { assertViewWorkOrder } from "../../../../_lib";

function withId(fn: (id: string, photoId: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string; photoId: string }> }) => {
    const { id, photoId } = await ctx.params;
    return handler((c) => fn(id, photoId, c), { permission })(req);
  };
}

export const GET = withId(
  async (id, photoId, { user }) => {
    const doc = await db.document.findUnique({ where: { id: photoId } });
    if (!doc || doc.resourceType !== "WORK_ORDER" || doc.resourceId !== id) throw Errors.notFound("File not found.");
    const wo = await db.workOrder.findUnique({ where: { id }, select: { customerId: true, technicianId: true } });
    if (!wo) throw Errors.notFound("Work order not found.");
    await assertViewWorkOrder(user, wo);

    const file = await storage.get(doc.storagePath);
    if (!file) throw Errors.notFound("File not found.");

    const safeName = doc.safeName.replace(/["\\\r\n]/g, "");
    return new NextResponse(Buffer.from(file.buffer), {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.buffer.length),
        "Content-Disposition": `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(doc.safeName)}`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
  PERMISSIONS.work_orders_read
);
