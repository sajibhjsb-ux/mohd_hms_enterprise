// MOHD.HMS ENTERPRISE — QR ensure (first-time generate) endpoint (§29/§60).
// POST /api/v1/qr/{entityType}/{entityId}/ensure — get-or-create the ONE
// canonical identity. Used by entity detail pages for records created before
// the central system existed, and by admin flows. MANAGE permission (§52).

import { NextRequest } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import {
  ensureQr, managePermissionFor, verificationUrl, qrDataUrl, requestOrigin,
  type QrEntityType,
} from "@/lib/hms/qr/service";

export const POST = async (req: NextRequest, ctx: { params: Promise<{ entityType: string; entityId: string }> }) => {
  const { entityType, entityId } = await ctx.params;
  const manage = managePermissionFor(entityType);
  if (!manage) throw Errors.notFound("Unknown QR entity type.");

  return handler(
    async ({ req: request, user }) => {
      const qr = await ensureQr(entityType as QrEntityType, entityId, {
        verificationType: entityType === "EQUIPMENT" ? "EQUIPMENT" : "DOCUMENT",
        issuedById: user.id,
        auditContext: "ui-ensure",
      });
      if (!qr) throw Errors.internal("QR generation failed.");

      const url = await verificationUrl(qr.publicToken, requestOrigin(request));
      const dataUrl = await qrDataUrl(url, 256);
      return ok({
        qr: {
          id: qr.id,
          status: qr.status,
          verificationUrl: url,
          issuedAt: qr.issuedAt,
          expiresAt: qr.expiresAt,
          verifyCount: qr.verifyCount,
          lastVerifiedAt: qr.lastVerifiedAt,
          dataUrl,
        },
        canManage: true,
        entityType,
      });
    },
    { permission: manage }
  )(req);
};
