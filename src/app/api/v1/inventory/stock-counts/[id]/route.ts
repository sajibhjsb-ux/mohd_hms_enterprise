// MOHD.HMS ENTERPRISE — Stock count detail (Inventory spec §31).
// GET /api/v1/inventory/stock-counts/[id] — count sheet with lines + item info.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS } from "@/lib/hms/constants";

function withId(
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

export const GET = withId(PERMISSIONS.inventory_read, async (id) => {
  const count = await db.stockCount.findUnique({
    where: { id },
    include: {
      warehouse: { select: { id: true, code: true, name: true } },
      lines: {
        orderBy: { id: "asc" },
        include: { item: { select: { sku: true, name: true, unit: true, category: true } } },
      },
    },
  });
  if (!count) throw Errors.notFound("Stock count not found.");
  return ok(count);
});
