// MOHD.HMS ENTERPRISE — WhatsApp configuration API (§9/§36/§53).
import type { NextResponse } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { getWhatsAppConfig, toSafeConfig, updateWhatsAppConfig } from "@/lib/hms/whatsapp/config";

export const GET = handler(async () => {
  const cfg = await getWhatsAppConfig();
  return ok(toSafeConfig(cfg));
}, { permission: PERMISSIONS.whatsapp_view });

const updateSchema = z.object({
  gatewayBaseUrl: z.string().url().max(300).optional(),
  apiKey: z.string().max(500).nullable().optional(),
  webhookSecret: z.string().min(16).max(200).nullable().optional(),
  sessionName: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/).optional(),
  enabled: z.boolean().optional(),
  autoReplies: z.boolean().optional(),
  testRecipient: z.string().max(30).optional(),
});

export const PATCH = handler(async ({ req, user }): Promise<NextResponse> => {
  const body = await parseBody(req, updateSchema);
  if (body.apiKey !== undefined && body.apiKey !== null && body.apiKey.trim().length < 8) {
    throw Errors.badRequest("API key looks too short to be valid.");
  }
  const updated = await updateWhatsAppConfig(body);
  void audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_CONFIG_UPDATED",
    resourceType: "WHATSAPP_CONFIG", resourceId: "singleton",
    metadata: {
      fields: Object.keys(body).filter((k) => k !== "apiKey" && k !== "webhookSecret"),
      apiKeyChanged: body.apiKey !== undefined && body.apiKey !== "",
      webhookSecretChanged: body.webhookSecret !== undefined && body.webhookSecret !== "",
      baseUrl: updated.gatewayBaseUrl, enabled: updated.enabled,
    },
  });
  return ok(updated);
}, { permission: PERMISSIONS.whatsapp_config });
