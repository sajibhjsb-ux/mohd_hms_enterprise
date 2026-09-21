// MOHD.HMS ENTERPRISE — WhatsApp session QR (§10). The QR is a PNG data URL
// straight from the gateway; only authorized admins may fetch it.
import type { NextResponse } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { getSessionQrDataUrl } from "@/lib/hms/whatsapp/service";

export const GET = handler(async (): Promise<NextResponse> => {
  const res = await getSessionQrDataUrl();
  if (!res.ok) {
    // "Re-establishing" is the honest live state, not a failure — return it
    // typed so the dialog shows a waiting panel instead of a red error while
    // the engine's reconnect backoff produces the next fresh QR.
    if (res.state === "WAITING") return ok({ qr: null, state: "WAITING", detail: res.detail });
    throw Errors.badRequest(res.detail);
  }
  return ok({ qr: res.qr, state: "READY", detail: "ok" });
}, { permission: PERMISSIONS.whatsapp_connect });
