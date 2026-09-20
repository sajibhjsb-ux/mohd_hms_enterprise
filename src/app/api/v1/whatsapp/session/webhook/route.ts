// MOHD.HMS ENTERPRISE — webhook registration on the gateway (§17/§18).
import type { NextResponse } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { ensureWebhook } from "@/lib/hms/whatsapp/service";

export const POST = handler(async ({ user }): Promise<NextResponse> => {
  const result = await ensureWebhook();
  void audit({
    actorId: user.id, actorEmail: user.email,
    action: result.ok ? "WHATSAPP_WEBHOOK_REGISTERED" : "WHATSAPP_WEBHOOK_REGISTER_FAILED",
    resourceType: "WHATSAPP_CONFIG", resourceId: "singleton", metadata: { detail: result.detail },
  });
  if (!result.ok) throw Errors.badRequest(result.detail);
  return ok({ ok: true, detail: result.detail });
}, { permission: PERMISSIONS.whatsapp_connect });
