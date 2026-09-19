// MOHD.HMS ENTERPRISE — Equipment QR endpoint.
// Resolves the unit by id (or ?token=qrToken), builds the scan deep-link from
// the public_url setting (fallback: request origin) and returns a PNG data URL.

import { NextRequest } from "next/server";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { isStaff } from "@/lib/hms/rbac";
import type { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/hms/auth";
import type { Permission } from "@/lib/hms/constants";

/**
 * Next.js 16 App Router: dynamic route params arrive as a Promise in the 2nd
 * handler argument. Bridge: resolve params, then delegate to handler().
 */
const withId = (
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) => {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
};

export const GET = withId(PERMISSIONS.equipment_read, async (id, { req, user }) => {
  const qrToken = new URL(req.url).searchParams.get("token");

  const equipment = await db.equipment.findUnique({
    where: qrToken ? { qrToken } : { id },
    select: { id: true, assetTag: true, name: true, qrToken: true, customerId: true },
  });
  if (!equipment) throw Errors.notFound("Equipment not found.");

  // Customer portal users can only scan/see their own equipment.
  if (!isStaff(user.role) && equipment.customerId !== user.customerId) {
    throw Errors.notFound("Equipment not found.");
  }

  const setting = await db.setting.findUnique({ where: { key: "public_url" }, select: { value: true } });
  let base = setting?.value?.trim();
  if (!base) {
    try {
      base = new URL(req.url).origin;
    } catch {
      base = "";
    }
  }
  base = base.replace(/\/+$/, "");

  const url = `${base}/?resource=equipment:${equipment.qrToken}`;
  const dataUrl = await QRCode.toDataURL(url, {
    width: 320,
    margin: 1,
    color: { dark: "#14532d", light: "#ffffff" },
  });

  return ok({
    equipmentId: equipment.id,
    assetTag: equipment.assetTag,
    name: equipment.name,
    url,
    dataUrl,
  });
});
