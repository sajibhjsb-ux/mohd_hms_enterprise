// MOHD.HMS ENTERPRISE — QR regenerate endpoint (ch.35 §29/§30/§52).
// POST /api/v1/qr/{entityType}/{entityId}/regenerate — explicit, authorized
// rotation: old identity → REVOKED, new identity → ACTIVE, all audited.
// Regular users opening a record NEVER trigger this (§30).

import { NextRequest } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import {
  regenerateQr, managePermissionFor, verificationUrl, qrDataUrl, requestOrigin,
  type QrEntityType,
} from "@/lib/hms/qr/service";

export const POST = async (req: NextRequest, ctx: { params: Promise<{ entityType: string; entityId: string }> }) => {
  const { entityType, entityId } = await ctx.params;
  const manage = managePermissionFor(entityType);
  if (!manage) throw Errors.notFound("Unknown QR entity type.");

  return handler(
    async ({ req: request, user }) => {
      const qr = await regenerateQr(entityType as QrEntityType, entityId, { id: user.id, email: user.email });
      const url = await verificationUrl(qr.publicToken, requestOrigin(request));
      const dataUrl = await qrDataUrl(url, 256);
      return ok({
        qr: {
          id: qr.id,
          status: qr.status,
          verificationUrl: url,
          issuedAt: qr.issuedAt,
          expiresAt: qr.expiresAt,
          verifyCount: 0,
          lastVerifiedAt: null,
          dataUrl,
        },
        canManage: true,
        entityType,
      });
    },
    { permission: manage }
  )(req);
};
