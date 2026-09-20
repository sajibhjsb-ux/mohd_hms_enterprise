// MOHD.HMS ENTERPRISE — WhatsApp test message (§35). Rate-limited; the
// gateway's raw errors are never surfaced verbatim to the user.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { sendTestMessage } from "@/lib/hms/whatsapp/service";

const bodySchema = z.object({ to: z.string().min(6).max(30), message: z.string().max(500).optional() });

export const POST = handler(async ({ req, user }): Promise<NextResponse> => {
  const limited = rateLimit(`whatsapp-test-send:${user.id}:${clientIp(req)}`, 10, 60_000);
  if (!limited.allowed) throw Errors.tooMany();
  const body = await parseBody(req, bodySchema);
  const result = await sendTestMessage(body.to, body.message ?? "", user.id, user.email);
  void audit({
    actorId: user.id, actorEmail: user.email,
    action: result.ok ? "WHATSAPP_TEST_SENT" : "WHATSAPP_TEST_FAILED",
    resourceType: "WHATSAPP_CONFIG", resourceId: "singleton",
    metadata: { to: body.to, messageId: result.messageId ?? "" },
  });
  if (!result.ok) throw Errors.badRequest(result.detail);
  return ok({ ok: true, detail: result.detail, messageId: result.messageId });
}, { permission: PERMISSIONS.whatsapp_send });
