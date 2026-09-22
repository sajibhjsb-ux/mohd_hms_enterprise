// MOHD.HMS ENTERPRISE — Inventory item document streaming (Inventory spec §54).
// GET /api/v1/inventory/[id]/documents/[docId]/file — the ONLY way to read the
// bytes. The bucket is private: every download passes auth + RBAC here.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage } from "@/lib/hms/storage";

function withId(
  fn: (id: string, docId: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>,
  permission?: Permission
) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string; docId: string }> }) => {
    const { id, docId } = await ctx.params;
    return handler((c) => fn(id, docId, c), { permission })(req);
  };
}

export const GET = withId(
  async (id, docId) => {
    const doc = await db.document.findUnique({ where: { id: docId } });
    if (!doc || doc.resourceType !== "INVENTORY_ITEM" || doc.resourceId !== id) throw Errors.notFound("File not found.");
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
  PERMISSIONS.inventory_read
);
