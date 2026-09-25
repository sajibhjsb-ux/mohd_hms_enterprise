// MOHD.HMS ENTERPRISE — Equipment QR endpoint (public QR verification spec
// §2/§12/§21/§24/§34/§38). The label QR encodes THE canonical public
// verification URL (https://app.mohdhms.com/verify/{token}) built by the
// central QRService — never a module-constructed URL, never window.origin,
// never a private LAN address. Scanning it opens the public verification page
// (no login); the page offers "Open in MOHD.HMS" for signed-in staff, which
// rides the EXISTING equipment deep-link (/?resource=equipment:{qrToken}).
//
// `url`     → public verification URL (QR payload)
// `deepLink`→ internal in-app deep link (NOT encoded in the QR; used by the
//             app UI to jump to the asset record after verification)
//
// Resolves the unit by id (or ?token=qrToken for scan-to-open flows). Customer
// portal users may only label their own equipment. RBAC rides the equipment
// module's existing permissions.

import { NextRequest } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { isStaff } from "@/lib/hms/rbac";
import { db } from "@/lib/db";
import {
  ensureQr, verificationUrl, qrDataUrl, requestOrigin, type QrEntityType,
} from "@/lib/hms/qr/service";
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

  // Central QRService resolves-or-creates THE canonical identity (idempotent —
  // re-labeling the same asset NEVER rotates the token, spec §12/§38) and
  // builds the public verification URL from the single authoritative origin.
  const qr = await ensureQr("EQUIPMENT", equipment.id, {
    verificationType: "EQUIPMENT",
    auditContext: "equipment-label",
  });
  if (!qr) throw Errors.internal("QR generation failed — please try again.");

  const url = await verificationUrl(qr.publicToken, requestOrigin(req));
  const dataUrl = await qrDataUrl(url, 320);

  return ok({
    equipmentId: equipment.id,
    assetTag: equipment.assetTag,
    name: equipment.name,
    url,
    deepLink: `/?resource=equipment:${equipment.qrToken}`,
    dataUrl,
  });
});
