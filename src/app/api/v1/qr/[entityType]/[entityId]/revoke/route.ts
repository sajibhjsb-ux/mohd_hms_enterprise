// MOHD.HMS ENTERPRISE — QR revoke endpoint (ch.35 §29/§31/§52).
// POST /api/v1/qr/{entityType}/{entityId}/revoke { reason } — authorized
// administrators revoke the identity; every scan afterwards returns the
// honest REVOKED state. Requires a reason; audited (§53).

import { NextRequest } from "next/server";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { z } from "zod";
import {
  getActiveQr, revokeQr, managePermissionFor, type QrEntityType,
} from "@/lib/hms/qr/service";

const Body = z.object({ reason: z.string().trim().min(3, "A revocation reason is required.").max(300) });

export const POST = async (req: NextRequest, ctx: { params: Promise<{ entityType: string; entityId: string }> }) => {
  const { entityType, entityId } = await ctx.params;
  const manage = managePermissionFor(entityType);
  if (!manage) throw Errors.notFound("Unknown QR entity type.");

  return handler(
    async ({ req: request, user }) => {
      const { reason } = await parseBody(request, Body);
      const qr = await getActiveQr(entityType as QrEntityType, entityId);
      if (!qr) throw Errors.notFound("No active QR identity for this record.");
      const updated = await revokeQr(qr.id, { id: user.id, email: user.email }, reason);
      return ok({ qr: { id: updated.id, status: updated.status, revokedAt: updated.revokedAt, revokedReason: updated.revokedReason } });
    },
    { permission: manage }
  )(req);
};
