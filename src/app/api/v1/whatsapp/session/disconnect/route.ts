// MOHD.HMS ENTERPRISE — WhatsApp disconnect (§9/§34). body: { logout?: boolean }
// logout=true unlinks the session entirely (re-authentication required);
// default stops the engine only.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { disconnectSession } from "@/lib/hms/whatsapp/service";

const bodySchema = z.object({ logout: z.boolean().optional() });

export const POST = handler(async ({ req, user }): Promise<NextResponse> => {
  const body = await parseBody(req, bodySchema).catch(() => ({ logout: false }));
  const result = await disconnectSession(!!body.logout);
  void audit({
    actorId: user.id, actorEmail: user.email,
    action: result.ok ? "WHATSAPP_SESSION_DISCONNECTED" : "WHATSAPP_SESSION_DISCONNECT_FAILED",
    resourceType: "WHATSAPP_CONFIG", resourceId: "singleton",
    metadata: { logout: !!body.logout, detail: result.detail },
  });
  if (!result.ok) throw Errors.badRequest(result.detail);
  return ok({ ok: true, detail: result.detail });
}, { permission: PERMISSIONS.whatsapp_connect });
