// MOHD.HMS ENTERPRISE — WhatsApp session API (§8/§9/§34/§48).
// GET  = honest live status (gateway → mirror). POST = connect (create+start).
import type { NextResponse } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { getGatewayClientConfig, getWhatsAppConfig } from "@/lib/hms/whatsapp/config";
import { connectSession, syncSessionStatus } from "@/lib/hms/whatsapp/service";
import { mapSessionStatusToUi } from "@/lib/hms/whatsapp/types";

export const GET = handler(async () => {
  const gw = await getGatewayClientConfig();
  const cfg = await getWhatsAppConfig();
  // Live probe when configured — never trust the mirror alone (§48).
  let status = cfg.sessionStatus;
  let detail = cfg.sessionError;
  if (gw) {
    const live = await syncSessionStatus(gw);
    status = live.status;
    detail = live.detail === "ok" ? "" : live.detail;
  }
  const after = await getWhatsAppConfig();
  return ok({
    uiState: mapSessionStatusToUi(status),
    sessionStatus: status,
    sessionName: after.sessionName,
    phone: after.sessionPhone,
    pushName: after.sessionPushName,
    error: detail || after.sessionError,
    lastConnectedAt: after.lastConnectedAt?.toISOString() ?? null,
    lastHeartbeatAt: after.lastHeartbeatAt?.toISOString() ?? null,
    lastInboundAt: after.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: after.lastOutboundAt?.toISOString() ?? null,
    webhookRegistered: after.webhookRegistered,
    enabled: after.enabled,
  });
}, { permission: PERMISSIONS.whatsapp_view });

export const POST = handler(async ({ user }): Promise<NextResponse> => {
  const result = await connectSession();
  void audit({
    actorId: user.id, actorEmail: user.email,
    action: result.ok ? "WHATSAPP_SESSION_CONNECTED" : "WHATSAPP_SESSION_CONNECT_FAILED",
    resourceType: "WHATSAPP_CONFIG", resourceId: "singleton",
    metadata: { detail: result.detail },
  });
  if (!result.ok) throw Errors.badRequest(result.detail);
  return ok({ ok: true, detail: result.detail, qrRequired: result.qrRequired ?? false });
}, { permission: PERMISSIONS.whatsapp_connect });
