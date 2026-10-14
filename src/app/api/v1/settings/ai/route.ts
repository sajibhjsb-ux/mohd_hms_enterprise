// Settings → AI configuration API (central AI config spec §4/§5/§7/§8/§16/§17).
//
// GET  — global settings + every provider profile with MASKED credentials only.
// PUT  — update global settings and/or ONE provider profile. A new credential is
//        stored PENDING and only becomes active after a successful Test
//        Connection (spec §8); the previous working credential is untouched until
//        then. Changing a credential/model invalidates the previous verification
//        — a saved-but-untested profile is NEVER shown as Connected (spec §7).
//
// Access: the existing settings.manage RBAC permission (no parallel RBAC).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import { PERMISSIONS } from "@/lib/hms/constants";
import {
  AI_PROVIDERS,
  getGlobalConfig,
  getGlobalConfigRow,
  getProfiles,
  getProfile,
  prepareKeyUpdate,
  savedStatus,
} from "@/lib/hms/ai/service";
import { maskAiSecretHint } from "@/lib/hms/ai/crypto";

function mask(last4: string): string {
  return last4 ? `••••••••${last4}` : "";
}

export const GET = handler(
  async () => {
    const cfg = await getGlobalConfig();
    const profiles = await getProfiles();
    return ok({
      enabled: cfg.enabled,
      defaultProvider: cfg.provider,
      fallbackChain: cfg.fallbackChain,
      temperature: cfg.temperature,
      maxOutputTokens: cfg.maxOutputTokens,
      timeoutMs: cfg.timeoutMs,
      updatedByEmail: cfg.updatedByEmail,
      updatedAt: cfg.updatedAt,
      providers: AI_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        requiresKey: p.requiresKey,
        defaultModel: p.defaultModel,
        supportsDiscovery: p.supportsDiscovery,
        endpoint: p.endpoint,
        docsUrl: p.docsUrl,
        capabilities: p.capabilities,
        models: p.catalog.map((m) => ({ id: m.id, label: m.label, recommended: m.recommended, deprecated: m.deprecated, contextTokens: m.contextTokens, capabilities: m.capabilities })),
      })),
      profiles: profiles.map((p) => {
        const def = AI_PROVIDERS.find((d) => d.id === p.provider)!;
        return {
          provider: p.provider,
          label: p.label || def.label,
          requiresKey: def.requiresKey,
          configured: def.requiresKey ? Boolean(p.apiKeyEnc) || Boolean(p.pendingApiKeyEnc) : true,
          hasActiveKey: Boolean(p.apiKeyEnc),
          hasPendingKey: Boolean(p.pendingApiKeyEnc),
          maskedKey: mask(p.apiKeyLast4),
          pendingKeyMasked: mask(p.pendingApiKeyLast4),
          model: p.model,
          testedModel: p.testedModel,
          enabled: p.enabled,
          status: p.status,
          lastTestedAt: p.lastTestedAt,
          lastTestOk: p.lastTestOk,
          lastSuccessAt: p.lastSuccessAt,
          lastErrorCode: p.lastErrorCode,
          lastErrorMessage: p.lastErrorMessage,
          updatedAt: p.updatedAt,
        };
      }),
    });
  },
  { permission: PERMISSIONS.settings_manage }
);

const putSchema = z.object({
  enabled: z.boolean().optional(),
  defaultProvider: z.enum(["GOOGLE_GEMINI", "ANTHROPIC_CLAUDE", "OPENAI", "NVIDIA", "ZAI_PLATFORM"]).optional(),
  fallbackChain: z.array(z.enum(["GOOGLE_GEMINI", "ANTHROPIC_CLAUDE", "OPENAI", "NVIDIA"])).max(4).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(64).max(8192).optional(),
  timeoutMs: z.number().int().min(5000).max(120_000).optional(),
  profile: z
    .object({
      provider: z.enum(["GOOGLE_GEMINI", "ANTHROPIC_CLAUDE", "OPENAI", "NVIDIA", "ZAI_PLATFORM"]),
      model: z.string().trim().max(120).optional(),
      enabled: z.boolean().optional(),
      apiKey: z.string().trim().min(8).max(1024).optional(),
      clearApiKey: z.boolean().optional(),
    })
    .optional(),
});

export const PUT = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, putSchema);
    const before = await getGlobalConfigRow();
    const data: Record<string, unknown> = { updatedById: user.id, updatedByEmail: user.email };

    let providerChanged = false;
    if (body.defaultProvider !== undefined && body.defaultProvider !== before.provider) {
      providerChanged = true;
      data.provider = body.defaultProvider;
    }
    // Circular fallback guard: a provider may not fall back to itself.
    if (body.fallbackChain !== undefined) {
      const nextDefault = body.defaultProvider ?? before.provider;
      const chain = body.fallbackChain.filter((p) => p !== nextDefault);
      data.fallbackChain = [...new Set(chain)].join(",");
    }
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.temperature !== undefined) data.temperature = body.temperature;
    if (body.maxOutputTokens !== undefined) data.maxOutputTokens = body.maxOutputTokens;
    if (body.timeoutMs !== undefined) data.timeoutMs = body.timeoutMs;

    await getGlobalConfigRow(); // ensure singleton exists
    await db.aiConfiguration.update({ where: { id: before.id }, data });

    let profileAudit: Record<string, unknown> | null = null;
    if (body.profile) {
      const def = AI_PROVIDERS.find((p) => p.id === body.profile!.provider)!;
      await getProfiles(); // ensure the profile row exists
      const current = await getProfile(def.id);
      if (!current) throw Errors.notFound("AI provider profile not found.");

      const pdata: Record<string, unknown> = { updatedById: user.id, updatedByEmail: user.email };
      let keyUpdated = false;
      let keyCleared = false;
      let modelChanged = false;

      if (body.profile.enabled !== undefined) pdata.enabled = body.profile.enabled;
      if (body.profile.model !== undefined && body.profile.model !== current.model) {
        pdata.model = body.profile.model;
        modelChanged = true;
      }
      if (body.profile.clearApiKey) {
        pdata.apiKeyEnc = "";
        pdata.apiKeyLast4 = "";
        pdata.apiKeySetAt = null;
        pdata.pendingApiKeyEnc = "";
        pdata.pendingApiKeyLast4 = "";
        pdata.pendingKeySetAt = null;
        pdata.testedModel = "";
        keyCleared = true;
      } else if (body.profile.apiKey) {
        const prepared = prepareKeyUpdate(body.profile.apiKey);
        pdata.pendingApiKeyEnc = prepared.enc;
        pdata.pendingApiKeyLast4 = prepared.last4;
        pdata.pendingKeySetAt = prepared.setAt;
        keyUpdated = true;
      }

      // Honest status after a configuration (not test) change (spec §7):
      // credential/model change invalidates the previous verification.
      const nextForStatus = {
        apiKeyEnc: keyCleared ? "" : current.apiKeyEnc,
        pendingApiKeyEnc: keyUpdated ? "pending" : keyCleared ? "" : current.pendingApiKeyEnc,
        status: keyUpdated || keyCleared || modelChanged ? "SAVED_NOT_TESTED" : current.status,
      };
      pdata.status = savedStatus(nextForStatus, def.requiresKey);
      if (keyCleared) {
        pdata.testedModel = "";
        pdata.lastTestedAt = null;
        pdata.lastTestOk = null;
      }

      await db.aiProviderProfile.update({ where: { id: def.id }, data: pdata });
      profileAudit = {
        provider: def.id,
        model: body.profile.model ?? current.model,
        enabled: body.profile.enabled ?? current.enabled,
        keyUpdated,
        keyCleared,
        credential: maskAiSecretHint(current.apiKeyLast4),
      };
    }

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "AI_CONFIG_UPDATED",
      resourceType: "AiConfiguration",
      resourceId: before.id,
      metadata: {
        enabled: body.enabled ?? before.enabled,
        defaultProvider: body.defaultProvider ?? before.provider,
        providerChanged,
        fallbackChanged: body.fallbackChain !== undefined,
        profile: profileAudit,
        // Masked hint only — NEVER the credential itself (spec §8).
      },
    });

    const cfg = await getGlobalConfig();
    return ok({
      enabled: cfg.enabled,
      defaultProvider: cfg.provider,
      fallbackChain: cfg.fallbackChain,
      temperature: cfg.temperature,
      maxOutputTokens: cfg.maxOutputTokens,
      timeoutMs: cfg.timeoutMs,
    });
  },
  { permission: PERMISSIONS.settings_manage }
);
