// MOHD.HMS ENTERPRISE — PM evidence file streaming (PM §20).
// GET /api/v1/pm/photos/[id]/file — the ONLY way to read PM photo/video bytes.
// The bucket is fully private: every download passes auth + RBAC here and the
// buffer is streamed inline (same pattern as /api/v1/irms/photos/[id]/file).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage } from "@/lib/hms/storage";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const GET = withId(
  async (id, { user }) => {
    const doc = await db.document.findUnique({ where: { id } });
    if (!doc || doc.resourceType !== "PM_TASK") throw Errors.notFound("File not found.");

    // §44 defense-in-depth — a customer may only read evidence of own equipment.
    if (user.role === "CUSTOMER") {
      const task = await db.pmTask.findUnique({
        where: { id: doc.resourceId },
        select: { equipment: { select: { customerId: true } } },
      });
      if (!task || task.equipment.customerId !== user.customerId) throw Errors.forbidden();
    }

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
  PERMISSIONS.pm_read
);
