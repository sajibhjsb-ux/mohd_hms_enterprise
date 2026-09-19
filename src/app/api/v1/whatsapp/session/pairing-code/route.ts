// MOHD.HMS ENTERPRISE — WhatsApp phone-number pairing (§11).
// Only offered when the installed OpenWA version supports pairing codes.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { getSessionPairingCode } from "@/lib/hms/whatsapp/service";

const bodySchema = z.object({ phone: z.string().min(6).max(30) });

export const POST = handler(async ({ req, user }): Promise<NextResponse> => {
  const body = await parseBody(req, bodySchema);
  const result = await getSessionPairingCode(body.phone);
  void audit({
    actorId: user.id, actorEmail: user.email,
    action: result.ok ? "WHATSAPP_PAIRING_CODE_REQUESTED" : "WHATSAPP_PAIRING_CODE_FAILED",
    resourceType: "WHATSAPP_CONFIG", resourceId: "singleton", metadata: {},
  });
  if (!result.ok) throw Errors.badRequest(result.detail);
  return ok({ pairingCode: result.code });
}, { permission: PERMISSIONS.whatsapp_connect });
