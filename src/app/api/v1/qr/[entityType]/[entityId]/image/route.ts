// MOHD.HMS ENTERPRISE — QR PNG image endpoint (ch.35 §14/§29/§43).
// GET /api/v1/qr/{entityType}/{entityId}/image?size=512 → image/png encoding
// the public verification URL. Authenticated + module read permission (§52);
// download/print flows use this endpoint. ECC level H, quiet zone ≥ 2 (§43).

import { NextRequest, NextResponse } from "next/server";
import { handler, Errors } from "@/lib/hms/api";
import {
  getActiveQr, readPermissionFor, verificationUrl, qrPngBuffer, requestOrigin,
  type QrEntityType,
} from "@/lib/hms/qr/service";

export const GET = async (req: NextRequest, ctx: { params: Promise<{ entityType: string; entityId: string }> }) => {
  const { entityType, entityId } = await ctx.params;
  const permission = readPermissionFor(entityType);
  if (!permission) throw Errors.notFound("Unknown QR entity type.");

  return handler(
    async ({ req: request }) => {
      const qr = await getActiveQr(entityType as QrEntityType, entityId);
      if (!qr) throw Errors.notFound("No QR identity has been generated for this record yet.");

      const rawSize = new URL(request.url).searchParams.get("size");
      const size = Math.min(1024, Math.max(128, Number(rawSize) || 512));
      const url = await verificationUrl(qr.publicToken, requestOrigin(request));
      const png = await qrPngBuffer(url, size);

      return new NextResponse(new Uint8Array(png), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(png.length),
          // the token is stable (§12/§33) — private short cache is safe and
          // still revalidates against auth on every request
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `inline; filename="mohd-hms-qr-${entityType.toLowerCase()}.png"`,
        },
      });
    },
    { permission }
  )(req);
};

export const dynamic = "force-dynamic";
