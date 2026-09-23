// Settings → AI configuration API (central AI config spec §2/§4/§6/§17/§29/§32).
// GET  — masked configuration view (NEVER returns the raw/encrypted key).
// PUT  — update provider/model/enabled/parameters; rotate or clear credential.
//        Rotation stores the NEW key as PENDING; it only becomes active after
//        a successful Test Connection (spec §17) — the previously working
//        credential is never destroyed before that.
// Access: settings.manage RBAC (the existing Settings permission model — no
// parallel RBAC, spec §6). Unauthorized users get 403 and can never read or
// mutate the credential.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import { PERMISSIONS } from "@/lib/hms/constants";
import { AI_PROVIDERS, getAiConfigRow, invalidateAiConfigCache, prepareKeyUpdate } from "@/lib/hms/ai/service";
import { maskAiSecretHint } from "@/lib/hms/ai/crypto";

export const GET = handler(
  async ({ user }) => {
    const row = await getAiConfigRow();
    const providerDef = AI_PROVIDERS.find((p) => p.id === row.provider) ?? AI_PROVIDERS[0];
    return ok({
      provider: row.provider,
      providerLabel: providerDef.label,
      providerRequiresKey: providerDef.requiresKey,
      configured: providerDef.requiresKey ? Boolean(row.apiKeyEnc) : true,
      enabled: row.enabled,
      model: row.model,
      // Masked hint only — the raw key is never returned by ANY API (spec §3/§32).
      maskedKey: row.apiKeyEnc ? `••••••••${row.apiKeyLast4}` : "",
      hasPendingKey: Boolean(row.pendingApiKeyEnc),
      pendingKeyMasked: row.pendingApiKeyEnc ? `••••••••${row.pendingApiKeyLast4}` : "",
      temperature: row.temperature,
      maxOutputTokens: row.maxOutputTokens,
      timeoutMs: row.timeoutMs,
      // NOT_CONFIGURED | CONFIGURED | ACTIVE | FAILED
      status: row.status,
      lastTestedAt: row.lastTestedAt,
      lastTestOk: row.lastTestOk,
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: row.lastErrorMessage,
      updatedByEmail: row.updatedByEmail,
      updatedAt: row.updatedAt,
      actorEmail: user.email,
    });
  },
  { permission: PERMISSIONS.settings_manage }
);

const putSchema = z.object({
  provider: z.enum(["ZAI_PLATFORM", "GOOGLE_GEMINI"]).optional(),
  model: z.string().trim().max(64).optional(),
  enabled: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(64).max(8192).optional(),
  timeoutMs: z.number().int().min(5000).max(120_000).optional(),
  // New credential (rotation) — stored PENDING until Test Connection succeeds.
  apiKey: z.string().trim().min(10).max(512).optional(),
  clearApiKey: z.boolean().optional(),
});

export const PUT = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, putSchema);

    const before = await getAiConfigRow();
    const data: Record<string, unknown> = {
      updatedById: user.id,
      updatedByEmail: user.email,
    };

    let keyUpdated = false;
    let keyCleared = false;
    let providerChanged = false;
    let nextProvider = before.provider;

    if (body.provider !== undefined && body.provider !== before.provider) {
      providerChanged = true;
      nextProvider = body.provider;
      data.provider = body.provider;
    }
    if (body.model !== undefined) data.model = body.model;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.temperature !== undefined) data.temperature = body.temperature;
    if (body.maxOutputTokens !== undefined) data.maxOutputTokens = body.maxOutputTokens;
    if (body.timeoutMs !== undefined) data.timeoutMs = body.timeoutMs;

    if (body.clearApiKey) {
      // Explicit clear: wipe both active and pending credentials.
      data.apiKeyEnc = "";
      data.apiKeyLast4 = "";
      data.apiKeySetAt = null;
      data.pendingApiKeyEnc = "";
      data.pendingApiKeyLast4 = "";
      data.pendingKeySetAt = null;
      keyCleared = true;
    } else if (body.apiKey !== undefined) {
      // Rotation (spec §17): NEW key goes to pending — active key untouched.
      const prepared = prepareKeyUpdate(body.apiKey);
      data.pendingApiKeyEnc = prepared.enc;
      data.pendingApiKeyLast4 = prepared.last4;
      data.pendingKeySetAt = prepared.setAt;
      keyUpdated = true;
    }

    // Honest status after the change (spec §19/§34):
    const willHaveKey =
      (typeof data.apiKeyEnc === "string" ? data.apiKeyEnc !== "" : Boolean(before.apiKeyEnc)) ||
      (typeof data.pendingApiKeyEnc === "string" ? data.pendingApiKeyEnc !== "" : Boolean(before.pendingApiKeyEnc));
    if (nextProvider === "ZAI_PLATFORM") {
      // Provider switch resets the connection state until a real test runs.
      if (providerChanged) data.status = "NOT_CONFIGURED";
    } else if (!willHaveKey || keyCleared) {
      data.status = "NOT_CONFIGURED";
    }

    const row = await db.aiConfiguration.update({ where: { id: before.id }, data });
    invalidateAiConfigCache();

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "AI_CONFIG_UPDATED",
      resourceType: "AiConfiguration",
      resourceId: row.id,
      metadata: {
        provider: row.provider,
        model: row.model,
        enabled: row.enabled,
        keyUpdated,
        keyCleared,
        pendingKeySaved: Boolean(row.pendingApiKeyEnc),
        // Masked hint only — NEVER the credential itself (spec §3/§29).
        credential: maskAiSecretHint(row.apiKeyLast4),
      },
    });

    return ok({
      provider: row.provider,
      enabled: row.enabled,
      model: row.model,
      status: row.status,
      hasPendingKey: Boolean(row.pendingApiKeyEnc),
      pendingKeyMasked: row.pendingApiKeyEnc ? `••••••••${row.pendingApiKeyLast4}` : "",
      maskedKey: row.apiKeyEnc ? `••••••••${row.apiKeyLast4}` : "",
    });
  },
  { permission: PERMISSIONS.settings_manage }
);
