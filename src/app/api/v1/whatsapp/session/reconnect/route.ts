// MOHD.HMS ENTERPRISE — WhatsApp reconnect (stop + start, honest state).
import type { NextResponse } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { disconnectSession, connectSession } from "@/lib/hms/whatsapp/service";

export const POST = handler(async ({ user }): Promise<NextResponse> => {
  await disconnectSession(false);
  const result = await connectSession();
  void audit({
    actorId: user.id, actorEmail: user.email,
    action: result.ok ? "WHATSAPP_SESSION_RECONNECTED" : "WHATSAPP_SESSION_RECONNECT_FAILED",
    resourceType: "WHATSAPP_CONFIG", resourceId: "singleton",
    metadata: { detail: result.detail },
  });
  if (!result.ok) throw Errors.badRequest(result.detail);
  return ok({ ok: true, detail: result.detail });
}, { permission: PERMISSIONS.whatsapp_connect });
