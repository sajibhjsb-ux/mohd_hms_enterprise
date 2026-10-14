// MOHD.HMS ENTERPRISE — CENTRAL AI SERVICE (server-only).
//
// This is the ONE backend AI service in the application. Every AI-powered
// module calls THIS service — no module initialises its own provider client
// or holds its own key.
//
//   Browser → Next.js API route → AIService (here) → provider adapter → provider API
//
// Responsibilities: global configuration, per-provider profile resolution,
// credential decryption, provider-specific request generation, model
// discovery, timeouts, bounded retries with backoff, rate limiting, safe error
// classification, optional cross-provider fallback, structured-output
// validation, usage logging (safe metadata only) and HONEST failure states.
//
// HONESTY (spec §7): the connection state is authored HERE by a real,
// validated provider request. A saved key, a non-empty string, a listed model
// or an enabled toggle are NEVER proof of connectivity.

import "server-only";
import { randomUUID } from "crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { decryptAiSecret, encryptAiSecret } from "./crypto";
import {
  AI_PROVIDERS,
  getProviderDef,
  getCatalogModel,
  type AiModelInfo,
  type AiProviderDef,
  type AiProviderId,
} from "./providers";

export { AI_PROVIDERS };
export type { AiProviderId };

export const AI_DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

// ── Public result + error types ──────────────────────────────────────────────

export type AiErrorCode =
  | "AI_DISABLED"
  | "AI_NOT_CONFIGURED"
  | "AI_RATE_LIMITED"
  | "AI_AUTH_FAILED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_MODEL_UNAVAILABLE"
  | "AI_MODEL_DEPRECATED"
  | "AI_TIMEOUT"
  | "AI_SERVICE_UNAVAILABLE"
  | "AI_BAD_RESPONSE"
  | "AI_PROVIDER_ERROR";

export type AiConnectionStatus =
  | "NOT_CONFIGURED"
  | "SAVED_NOT_TESTED"
  | "TESTING"
  | "CONNECTED"
  | "FAILED"
  | "AUTH_FAILED"
  | "MODEL_UNAVAILABLE"
  | "MODEL_DEPRECATED"
  | "RATE_LIMITED"
  | "QUOTA_ISSUE"
  | "SERVICE_UNAVAILABLE";

export type AiUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };

export type AiTextResult =
  | { ok: true; text: string; provider: string; model: string; requestId: string; usage: AiUsage; durationMs: number; attempted?: string[] }
  | { ok: false; code: AiErrorCode; message: string; provider: string; model: string; requestId: string; durationMs: number; attempted?: string[] };

export type AiStructuredResult<T> =
  | { ok: true; data: T; provider: string; model: string; requestId: string; usage: AiUsage; durationMs: number }
  | { ok: false; code: AiErrorCode; message: string; provider: string; model: string; requestId: string; durationMs: number };

export type AiGenerateOptions = {
  /** Feature identifier from the central registry, e.g. "inspection_report". */
  feature: string;
  /** Global system instructions are always prepended; this adds feature-specific rules. */
  system?: string;
  prompt: string;
  /** Ask the provider for a JSON object response (structured mode). */
  json?: boolean;
  /** Optional per-call temperature override (clamped to config bounds). */
  temperature?: number;
  userId?: string | null;
  /** Force a specific provider (default: the configured default provider chain). */
  providerOverride?: AiProviderId;
  /** Per-call timeout override (clamped to the configured bound) — e.g. inbound webhooks that must answer fast. */
  timeoutMs?: number;
};

// ── Global system instructions (safety rules live HERE, not per feature) ─────

export const AI_GLOBAL_SYSTEM_INSTRUCTIONS = [
  "You are the central AI assistant of MOHD.HMS ENTERPRISE, a facility-management company (HVAC, electrical, mechanical and safety services for commercial buildings in Brunei Darussalam).",
  "STRICT SAFETY RULES: never invent manufacturer specifications, model numbers, electrical ratings, refrigerant pressures, torque values, temperature limits, compliance requirements or safety limits; use ONLY the facts provided in the request context.",
  "All output is DRAFT ASSISTANCE for review by a qualified human — it is never a final business decision.",
  "Never include credentials, secrets, API keys or internal system details in your output.",
].join(" ");

// ── Configuration access (PostgreSQL authoritative; no in-memory cache) ──────

export type AiGlobalConfig = {
  id: string;
  enabled: boolean;
  provider: AiProviderId; // default provider
  fallbackChain: AiProviderId[];
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  updatedByEmail: string;
  updatedAt: Date;
};

export type AiProfileRow = {
  provider: AiProviderId;
  label: string;
  apiKeyEnc: string;
  apiKeyLast4: string;
  pendingApiKeyEnc: string;
  pendingApiKeyLast4: string;
  model: string;
  testedModel: string;
  enabled: boolean;
  status: string;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string;
  lastErrorMessage: string;
  priority: number;
  updatedAt: Date;
};

/** Kept for API compatibility — the DB is the single source of truth. */
export function invalidateAiConfigCache(): void {
  /* intentional no-op */
}

export async function getGlobalConfigRow() {
  const existing = await db.aiConfiguration.findUnique({ where: { id: "singleton" } });
  if (existing) return existing;
  try {
    return await db.aiConfiguration.create({ data: { id: "singleton" } });
  } catch {
    const row = await db.aiConfiguration.findUnique({ where: { id: "singleton" } });
    if (!row) throw new Error("AI configuration row could not be created.");
    return row;
  }
}

/** Backwards-compatible alias (old settings route referenced this name). */
export const getAiConfigRow = getGlobalConfigRow;

export async function getGlobalConfig(): Promise<AiGlobalConfig> {
  const row = await getGlobalConfigRow();
  return {
    id: row.id,
    enabled: row.enabled,
    provider: (getProviderDef(row.provider)?.id ?? "ZAI_PLATFORM") as AiProviderId,
    fallbackChain: parseChain(row.fallbackChain),
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    timeoutMs: row.timeoutMs,
    updatedByEmail: row.updatedByEmail,
    updatedAt: row.updatedAt,
  };
}

function parseChain(raw: string): AiProviderId[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => getProviderDef(s) !== null)
    .map((s) => s as AiProviderId);
}

/**
 * Ensure a profile row exists for every supported provider. The legacy
 * singleton credential (pre-multi-provider deployments) is migrated into the
 * matching profile ONCE, so no saved configuration is lost.
 */
export async function getProfiles(): Promise<AiProfileRow[]> {
  const existing = await db.aiProviderProfile.findMany();
  const byProvider = new Map(existing.map((p) => [p.provider, p]));
  const legacy = await getGlobalConfigRow();

  for (const def of AI_PROVIDERS) {
    if (byProvider.has(def.id)) continue;
    try {
      await db.aiProviderProfile.create({
        data: {
          id: def.id,
          provider: def.id,
          label: def.label,
          model: "",
          enabled: true,
          status: "NOT_CONFIGURED",
          // Migrate the legacy singleton credential into the matching profile.
          ...(legacy.provider === def.id && legacy.apiKeyEnc
            ? { apiKeyEnc: legacy.apiKeyEnc, apiKeyLast4: legacy.apiKeyLast4, apiKeySetAt: legacy.apiKeySetAt }
            : {}),
          ...(legacy.provider === def.id && legacy.pendingApiKeyEnc
            ? { pendingApiKeyEnc: legacy.pendingApiKeyEnc, pendingApiKeyLast4: legacy.pendingApiKeyLast4, pendingKeySetAt: legacy.pendingKeySetAt }
            : {}),
          ...(legacy.provider === def.id && legacy.model ? { model: legacy.model } : {}),
        },
      });
    } catch {
      /* concurrent creation — the row now exists */
    }
  }
  const all = await db.aiProviderProfile.findMany();
  return all.map(toProfileRow);
}

export async function getProfile(provider: string): Promise<AiProfileRow | null> {
  const def = getProviderDef(provider);
  if (!def) return null;
  await getProfiles(); // ensure seeded
  const row = await db.aiProviderProfile.findUnique({ where: { id: def.id } });
  return row ? toProfileRow(row) : null;
}

function toProfileRow(r: {
  provider: string; label: string; apiKeyEnc: string; apiKeyLast4: string;
  pendingApiKeyEnc: string; pendingApiKeyLast4: string; model: string; testedModel: string;
  enabled: boolean; status: string; lastTestedAt: Date | null; lastTestOk: boolean | null;
  lastSuccessAt: Date | null; lastErrorCode: string; lastErrorMessage: string; priority: number; updatedAt: Date;
}): AiProfileRow {
  return {
    provider: (getProviderDef(r.provider)?.id ?? "ZAI_PLATFORM") as AiProviderId,
    label: r.label,
    apiKeyEnc: r.apiKeyEnc,
    apiKeyLast4: r.apiKeyLast4,
    pendingApiKeyEnc: r.pendingApiKeyEnc,
    pendingApiKeyLast4: r.pendingApiKeyLast4,
    model: r.model,
    testedModel: r.testedModel,
    enabled: r.enabled,
    status: r.status,
    lastTestedAt: r.lastTestedAt,
    lastTestOk: r.lastTestOk,
    lastSuccessAt: r.lastSuccessAt,
    lastErrorCode: r.lastErrorCode,
    lastErrorMessage: r.lastErrorMessage,
    priority: r.priority,
    updatedAt: r.updatedAt,
  };
}

/** Honest state after a configuration (not test) change (spec §7). */
export function savedStatus(profile: Pick<AiProfileRow, "apiKeyEnc" | "pendingApiKeyEnc" | "status">, requiresKey: boolean): AiConnectionStatus {
  const hasKey = Boolean(profile.apiKeyEnc) || Boolean(profile.pendingApiKeyEnc);
  if (requiresKey && !hasKey) return "NOT_CONFIGURED";
  // Credential changes invalidate any previous verification: never keep CONNECTED.
  if (profile.status === "CONNECTED" && profile.pendingApiKeyEnc) return "SAVED_NOT_TESTED";
  if (profile.status === "CONNECTED") return "CONNECTED";
  return "SAVED_NOT_TESTED";
}

// ── Credential write helpers ─────────────────────────────────────────────────

export function prepareKeyUpdate(plainKey: string): { enc: string; last4: string; setAt: Date } {
  const trimmed = plainKey.trim();
  return { enc: encryptAiSecret(trimmed), last4: trimmed.slice(-4), setAt: new Date() };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_USER = 20;
const RATE_LIMIT_GLOBAL = 120;
const rateBuckets = new Map<string, number[]>();

function allowRate(key: string, limit: number): boolean {
  const now = Date.now();
  const arr = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= limit) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

// ── Usage logging (safe metadata only; never the key, never the raw prompt) ──

async function logUsage(entry: {
  userId?: string | null;
  feature: string;
  requestId: string;
  provider: string;
  model: string;
  status: "SUCCESS" | "FAILED" | "REJECTED";
  durationMs: number;
  usage?: AiUsage;
  errorCode?: string;
}): Promise<void> {
  try {
    await db.aiUsageLog.create({
      data: {
        userId: entry.userId ?? null,
        feature: entry.feature,
        requestId: entry.requestId,
        provider: entry.provider,
        model: entry.model,
        status: entry.status,
        inputTokens: entry.usage?.inputTokens ?? null,
        outputTokens: entry.usage?.outputTokens ?? null,
        totalTokens: entry.usage?.totalTokens ?? null,
        durationMs: entry.durationMs,
        errorCode: entry.errorCode ?? "",
      },
    });
  } catch {
    /* usage logging must never break the AI response path */
  }
}

// ── Promise with an abortable timeout ────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AiHttpError(504, "AI_TIMEOUT", "The AI request timed out. Please try again.")), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export class AiHttpError extends Error {
  status: number;
  code: AiErrorCode;
  constructor(status: number, code: AiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── Error classification (per-provider bodies, honest categories) ────────────

export function classifyError(status: number, bodyText: string): { code: AiErrorCode; message: string } {
  const hay = bodyText.toUpperCase();
  const quota = /INSUFFICIENT_QUOTA|EXCEEDED YOUR CURRENT QUOTA|BILLING|PAYMENT REQUIRED|INSUFFICIENT FUNDS|OUT OF CREDIT/.test(hay);
  const deprecated = /END[ -]OF[ -]LIFE|NO LONGER AVAILABLE|HAS BEEN DEPRECATED|IS DEPRECATED|DEPRECATED|RETIRED|SUPERSEDED/.test(hay);
  const modelMissing = /MODEL.*(NOT FOUND|DOES NOT EXIST|UNAVAILABLE|UNKNOWN|INVALID)|NOT FOUND.*MODEL|UNSUPPORTED MODEL|NOT FOUND FOR ACCOUNT/.test(hay);
  const auth = /API[_ ]?KEY|UNAUTHENTICATED|PERMISSION_DENIED|INVALID.*(KEY|TOKEN|CREDENTIAL)|AUTHENTICATION/.test(hay);

  // 410 Gone / explicit end-of-life notice (NVIDIA RFC7807 problem+json, Gemini
  // "no longer available") — the model exists but its endpoint is retired.
  if (status === 410 || (!auth && deprecated && !quota)) {
    return { code: "AI_MODEL_DEPRECATED", message: "The selected model has been retired by the provider and can no longer be used. Choose or discover a current model." };
  }
  if (status === 401 || status === 403) {
    if (quota) return { code: "AI_QUOTA_EXCEEDED", message: "The AI provider reports a quota or billing issue with this credential." };
    return { code: "AI_AUTH_FAILED", message: "Authentication failed. Verify the credential and its API restrictions in Settings → AI." };
  }
  if (status === 402) return { code: "AI_QUOTA_EXCEEDED", message: "The AI provider reports a billing or quota problem with this credential." };
  if (status === 429) {
    if (quota) return { code: "AI_QUOTA_EXCEEDED", message: "The AI provider quota has been exceeded (billing/quota, not a temporary rate limit)." };
    return { code: "AI_RATE_LIMITED", message: "The AI provider is rate limiting requests. Please wait a moment and try again." };
  }
  if (status === 404 || modelMissing) return { code: "AI_MODEL_UNAVAILABLE", message: "The requested model is not available to this credential. Try another model." };
  if (status === 400) {
    if (auth) return { code: "AI_AUTH_FAILED", message: "Authentication failed. Verify the credential in Settings → AI." };
    return { code: "AI_PROVIDER_ERROR", message: "The AI provider rejected the request (invalid model or parameters)." };
  }
  if (status >= 500 || status === 408) return { code: "AI_SERVICE_UNAVAILABLE", message: "The AI provider is temporarily unavailable. Please try again." };
  return { code: "AI_PROVIDER_ERROR", message: "The AI provider reported a problem. Please try again." };
}

export function isRetryableAiCode(code: string): boolean {
  return code === "AI_RATE_LIMITED" || code === "AI_SERVICE_UNAVAILABLE" || code === "AI_TIMEOUT" || code === "AI_PROVIDER_ERROR";
}

export function statusForError(code: AiErrorCode): AiConnectionStatus {
  switch (code) {
    case "AI_AUTH_FAILED": return "AUTH_FAILED";
    case "AI_MODEL_UNAVAILABLE": return "MODEL_UNAVAILABLE";
    case "AI_MODEL_DEPRECATED": return "MODEL_DEPRECATED";
    case "AI_RATE_LIMITED": return "RATE_LIMITED";
    case "AI_QUOTA_EXCEEDED": return "QUOTA_ISSUE";
    case "AI_SERVICE_UNAVAILABLE": return "SERVICE_UNAVAILABLE";
    case "AI_TIMEOUT": return "SERVICE_UNAVAILABLE";
    case "AI_NOT_CONFIGURED": return "NOT_CONFIGURED";
    default: return "FAILED";
  }
}

// ── Provider adapters ────────────────────────────────────────────────────────

export type GenerateOutput = { text: string; usage: AiUsage; model: string };

async function httpJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await withTimeout(fetch(url, { ...init, cache: "no-store" }), timeoutMs).catch((e) => {
    if (e instanceof AiHttpError) throw e;
    throw new AiHttpError(502, "AI_SERVICE_UNAVAILABLE", "The AI provider could not be reached. Check network/outbound connectivity.");
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

/** Generic retrying call: bounded retries + exponential backoff for transient errors. */
async function callWithRetries(
  fn: () => Promise<GenerateOutput>,
  maxRetries = 2
): Promise<GenerateOutput> {
  let last: AiHttpError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err instanceof AiHttpError ? err : new AiHttpError(502, "AI_PROVIDER_ERROR", "The AI request failed.");
      last = e;
      if (!isRetryableAiCode(e.code) || attempt === maxRetries) throw e;
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }
  throw last ?? new AiHttpError(502, "AI_PROVIDER_ERROR", "The AI request failed.");
}

async function callGemini(def: AiProviderDef, key: string, model: string, system: string, user: string, json: boolean, temperature: number, maxTokens: number, timeoutMs: number): Promise<GenerateOutput> {
  const url = `${def.endpoint}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) },
  };
  const { status, ok, text } = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!ok) { const c = classifyError(status, text); throw new AiHttpError(status, c.code, c.message); }
  let json2: { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
  try { json2 = JSON.parse(text); } catch { throw new AiHttpError(502, "AI_BAD_RESPONSE", "The AI provider returned an unreadable response."); }
  const out = json2.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const u = json2.usageMetadata ?? {};
  return { text: out, usage: { inputTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null, totalTokens: u.totalTokenCount ?? null }, model };
}

async function callAnthropic(def: AiProviderDef, key: string, model: string, system: string, user: string, temperature: number, maxTokens: number, timeoutMs: number): Promise<GenerateOutput> {
  const url = `${def.endpoint}/messages`;
  const body = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: user }],
    temperature,
  };
  const { status, ok, text } = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!ok) { const c = classifyError(status, text); throw new AiHttpError(status, c.code, c.message); }
  let json2: { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
  try { json2 = JSON.parse(text); } catch { throw new AiHttpError(502, "AI_BAD_RESPONSE", "The AI provider returned an unreadable response."); }
  const out = (json2.content ?? []).filter((b) => b.type === "text" || b.text).map((b) => b.text ?? "").join("");
  const input = json2.usage?.input_tokens ?? null;
  const output = json2.usage?.output_tokens ?? null;
  return { text: out, usage: { inputTokens: input, outputTokens: output, totalTokens: input !== null && output !== null ? input + output : null }, model: json2.model ?? model };
}

async function callOpenAiCompatible(def: AiProviderDef, key: string, model: string, system: string, user: string, json: boolean, temperature: number, maxTokens: number, timeoutMs: number): Promise<GenerateOutput> {
  const url = `${def.endpoint}/chat/completions`;
  const body = {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };
  const { status, ok, text } = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!ok) { const c = classifyError(status, text); throw new AiHttpError(status, c.code, c.message); }
  let json2: { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; model?: string };
  try { json2 = JSON.parse(text); } catch { throw new AiHttpError(502, "AI_BAD_RESPONSE", "The AI provider returned an unreadable response."); }
  const out = json2.choices?.[0]?.message?.content ?? "";
  const input = json2.usage?.prompt_tokens ?? null;
  const output = json2.usage?.completion_tokens ?? null;
  return { text: out, usage: { inputTokens: input, outputTokens: output, totalTokens: json2.usage?.total_tokens ?? (input !== null && output !== null ? input + output : null) }, model: json2.model ?? model };
}

async function callZaiPlatform(system: string, user: string, timeoutMs: number): Promise<GenerateOutput> {
  const { default: ZAI } = await import("z-ai-web-dev-sdk");
  const zai = await ZAI.create();
  type ZaiCompletion = { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  const completion = (await withTimeout(
    zai.chat.completions.create({
      messages: [{ role: "assistant", content: system }, { role: "user", content: user }],
      thinking: { type: "disabled" },
    }),
    timeoutMs
  )) as ZaiCompletion;
  const input = completion.usage?.prompt_tokens ?? null;
  const output = completion.usage?.completion_tokens ?? null;
  return { text: String(completion.choices?.[0]?.message?.content ?? ""), usage: { inputTokens: input, outputTokens: output, totalTokens: completion.usage?.total_tokens ?? null }, model: "z-ai-chat" };
}

async function callProvider(def: AiProviderDef, key: string, model: string, system: string, user: string, opts: { json: boolean; temperature: number; maxTokens: number; timeoutMs: number }): Promise<GenerateOutput> {
  const fn = () => {
    switch (def.id) {
      case "GOOGLE_GEMINI":
        return callGemini(def, key, model, system, user, opts.json, opts.temperature, opts.maxTokens, opts.timeoutMs);
      case "ANTHROPIC_CLAUDE":
        return callAnthropic(def, key, model, system, user, opts.temperature, opts.maxTokens, opts.timeoutMs);
      case "OPENAI":
      case "NVIDIA":
        return callOpenAiCompatible(def, key, model, system, user, opts.json, opts.temperature, opts.maxTokens, opts.timeoutMs);
      case "ZAI_PLATFORM":
        return callZaiPlatform(system, user, opts.timeoutMs);
      default:
        return Promise.reject(new AiHttpError(502, "AI_PROVIDER_ERROR", "Unsupported AI provider."));
    }
  };
  return callWithRetries(fn);
}

// ── Model discovery ───────────────────────────────────────────────────────────

export type DiscoveredModel = { id: string; label: string; source: "discovered" | "catalog"; capabilities: AiModelInfo["capabilities"]; contextTokens?: number; deprecated?: boolean };

/** Discover models for a provider using the credential currently entered. */
export async function discoverModels(provider: string, apiKey: string, timeoutMs = 15_000): Promise<{ ok: true; models: DiscoveredModel[]; source: "discovered" | "catalog" } | { ok: false; code: AiErrorCode; message: string; models: DiscoveredModel[]; source: "catalog" }> {
  const def = getProviderDef(provider);
  if (!def) return { ok: false, code: "AI_MODEL_UNAVAILABLE", message: "Unknown provider.", models: [], source: "catalog" };
  const catalog: DiscoveredModel[] = def.catalog.map((m) => ({ id: m.id, label: m.label, source: "catalog", capabilities: m.capabilities, contextTokens: m.contextTokens, deprecated: m.deprecated }));
  if (!def.supportsDiscovery || !def.requiresKey || !apiKey) {
    return { ok: true, models: catalog, source: "catalog" };
  }
  try {
    const { status, ok, text } = await httpJson(`${def.endpoint}/models`, {
      headers:
        def.id === "GOOGLE_GEMINI" ? { "x-goog-api-key": apiKey }
        : def.id === "ANTHROPIC_CLAUDE" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${apiKey}` },
    }, timeoutMs);
    if (!ok) {
      const c = classifyError(status, text);
      return { ok: false, code: c.code, message: c.message, models: catalog, source: "catalog" };
    }
    const parsed: unknown = JSON.parse(text);
    const ids = extractModelIds(def, parsed);
    if (ids.length === 0) {
      return { ok: false, code: "AI_MODEL_UNAVAILABLE", message: "The provider returned no usable models for this credential.", models: catalog, source: "catalog" };
    }
    const models: DiscoveredModel[] = ids.map((m) => {
      const cat = getCatalogModel(def.id, m.id);
      return { ...m, source: "discovered" as const, capabilities: cat?.capabilities ?? def.capabilities, contextTokens: cat?.contextTokens, deprecated: false };
    });
    return { ok: true, models, source: "discovered" };
  } catch (err) {
    const e = err instanceof AiHttpError ? err : new AiHttpError(502, "AI_SERVICE_UNAVAILABLE", "Model discovery failed.");
    return { ok: false, code: e.code, message: e.message, models: catalog, source: "catalog" };
  }
}

function extractModelIds(def: AiProviderDef, parsed: unknown): { id: string; label: string }[] {
  const p = parsed as Record<string, unknown>;
  if (def.id === "GOOGLE_GEMINI") {
    const arr = (p.models as Array<Record<string, unknown>> | undefined) ?? [];
    return arr
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && (m.supportedGenerationMethods as string[]).includes("generateContent"))
      .map((m) => {
        const raw = String(m.name ?? "").replace(/^models\//, "");
        return { id: raw, label: String(m.displayName ?? raw) };
      })
      .filter((m) => m.id);
  }
  if (def.id === "ANTHROPIC_CLAUDE") {
    const arr = (p.data as Array<Record<string, unknown>> | undefined) ?? [];
    return arr.map((m) => ({ id: String(m.id ?? ""), label: String(m.display_name ?? m.id ?? "") })).filter((m) => m.id);
  }
  // OpenAI-compatible (OpenAI + NVIDIA).
  const arr = (p.data as Array<Record<string, unknown>> | undefined) ?? [];
  return arr.map((m) => ({ id: String(m.id ?? ""), label: String(m.id ?? "") })).filter((m) => m.id);
}

// ── Provider chain resolution + fallback (spec §10) ──────────────────────────

type ResolvedProvider = { def: AiProviderDef; profile: AiProfileRow; key: string };

async function resolveChain(cfg: AiGlobalConfig, override?: AiProviderId): Promise<{ chain: ResolvedProvider[]; skipped: string[] }> {
  const order: AiProviderId[] = override ? [override] : [cfg.provider, ...cfg.fallbackChain];
  const seen = new Set<string>();
  const chain: ResolvedProvider[] = [];
  const skipped: string[] = [];
  for (const pid of order) {
    if (seen.has(pid)) continue; // no circular/duplicate fallback
    seen.add(pid);
    const def = getProviderDef(pid);
    const profile = await getProfile(pid);
    if (!def || !profile) continue;
    if (!profile.enabled) { skipped.push(`${def.label}: disabled`); continue; }
    if (def.requiresKey) {
      // Only the verified ACTIVE credential is used for production traffic;
      // a pending (unverified) key is never used for generation (spec §8).
      const key = decryptAiSecret(profile.apiKeyEnc);
      if (!key) { skipped.push(`${def.label}: no credential`); continue; }
      chain.push({ def, profile, key });
    } else {
      chain.push({ def, profile, key: "" });
    }
  }
  return { chain, skipped };
}

function isRetiredCatalogModel(def: AiProviderDef, model: string): boolean {
  return getCatalogModel(def.id, model)?.deprecated === true;
}

/**
 * The model used for real generation. A model the admin explicitly chose is
 * kept UNLESS it is a catalogued retired/deprecated endpoint (HTTP 410), in
 * which case the last verified model — or the current default — is used so a
 * dead endpoint is never selected (spec §3).
 */
export function modelFor(def: AiProviderDef, profile: Pick<AiProfileRow, "model" | "testedModel">): string {
  const chosen = (profile.model || "").trim();
  if (chosen && !isRetiredCatalogModel(def, chosen)) return chosen;
  const tested = (profile.testedModel || "").trim();
  if (tested && !isRetiredCatalogModel(def, tested)) return tested;
  return def.defaultModel;
}

// ── Core text generation ──────────────────────────────────────────────────────

function buildMessages(opts: AiGenerateOptions): { system: string; user: string } {
  const system = opts.system ? `${AI_GLOBAL_SYSTEM_INSTRUCTIONS}\n\n${opts.system}` : AI_GLOBAL_SYSTEM_INSTRUCTIONS;
  return { system, user: opts.prompt };
}

export async function aiGenerate(opts: AiGenerateOptions): Promise<AiTextResult> {
  const requestId = randomUUID();
  const started = Date.now();
  const cfg = await getGlobalConfig();
  const attempted: string[] = [];

  const fail = (code: AiErrorCode, message: string, provider: string, model: string, status: "FAILED" | "REJECTED"): AiTextResult => {
    const durationMs = Date.now() - started;
    void logUsage({ userId: opts.userId, feature: opts.feature, requestId, provider, model, status, durationMs, errorCode: code });
    return { ok: false, code, message, provider, model, requestId, durationMs, attempted };
  };

  if (opts.userId && !allowRate(`user:${opts.userId}`, RATE_LIMIT_PER_USER)) {
    return fail("AI_RATE_LIMITED", "Too many AI requests. Please wait a moment and try again.", cfg.provider, "-", "REJECTED");
  }
  if (!allowRate("global", RATE_LIMIT_GLOBAL)) {
    return fail("AI_RATE_LIMITED", "The AI service is busy. Please wait a moment and try again.", cfg.provider, "-", "REJECTED");
  }
  if (!cfg.enabled) {
    return fail("AI_DISABLED", "AI service is currently disabled by the administrator.", cfg.provider, "-", "REJECTED");
  }

  const { chain, skipped } = await resolveChain(cfg, opts.providerOverride);
  if (chain.length === 0) {
    const reason = skipped.length ? ` (${skipped.join("; ")})` : "";
    return fail("AI_NOT_CONFIGURED", `No AI provider is configured and enabled. Configure one in Settings → AI.${reason}`, cfg.provider, "-", "REJECTED");
  }

  const { system, user } = buildMessages(opts);
  const temperature = Math.min(2, Math.max(0, opts.temperature ?? cfg.temperature));
  let lastCode: AiErrorCode = "AI_PROVIDER_ERROR";
  let lastMessage = "The AI request failed.";
  let lastProvider = chain[0].def.id as string;
  let lastModel = "-";

  for (const rp of chain) {
    const model = modelFor(rp.def, rp.profile);
    lastProvider = rp.def.id;
    lastModel = model;
    attempted.push(`${rp.def.id}:${model}`);
    try {
      const out = await callProvider(rp.def, rp.key, model, system, user, { json: Boolean(opts.json), temperature, maxTokens: cfg.maxOutputTokens, timeoutMs: opts.timeoutMs ?? cfg.timeoutMs });
      const text = out.text.trim();
      if (!text) {
        lastCode = "AI_BAD_RESPONSE";
        lastMessage = "The AI returned an empty response.";
        continue; // try next provider in the chain
      }
      const durationMs = Date.now() - started;
      void logUsage({ userId: opts.userId, feature: opts.feature, requestId, provider: rp.def.id, model: out.model, status: "SUCCESS", durationMs, usage: out.usage });
      return { ok: true, text, provider: rp.def.id, model: out.model, requestId, usage: out.usage, durationMs, attempted };
    } catch (err) {
      const e = err instanceof AiHttpError ? err : new AiHttpError(502, "AI_PROVIDER_ERROR", "The AI request failed.");
      lastCode = e.code;
      lastMessage = e.message;
      // Auth / invalid-request / policy problems are not fixed by another
      // provider only when there is no fallback — otherwise try the next one.
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "ai-generate-provider-failed", feature: opts.feature, provider: rp.def.id, model, code: e.code }));
    }
  }

  return fail(lastCode, lastMessage, lastProvider, lastModel, "FAILED");
}

// ── JSON extraction (shared) ──────────────────────────────────────────────────

export function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(cleaned.slice(start, i + 1));
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function aiGenerateStructured<T>(opts: AiGenerateOptions & { schema: z.ZodType<T> }): Promise<AiStructuredResult<T>> {
  const res = await aiGenerate({ ...opts, json: true });
  if (!res.ok) {
    return { ok: false, code: res.code, message: res.message, provider: res.provider, model: res.model, requestId: res.requestId, durationMs: res.durationMs };
  }
  const parsed = extractJsonObject(res.text);
  if (!parsed) {
    return { ok: false, code: "AI_BAD_RESPONSE", message: "The AI returned an unusable response format. Please try again.", provider: res.provider, model: res.model, requestId: res.requestId, durationMs: res.durationMs };
  }
  const validation = opts.schema.safeParse(parsed);
  if (!validation.success) {
    return { ok: false, code: "AI_BAD_RESPONSE", message: "The AI response did not match the required structure. Please try again.", provider: res.provider, model: res.model, requestId: res.requestId, durationMs: res.durationMs };
  }
  return { ok: true, data: validation.data, provider: res.provider, model: res.model, requestId: res.requestId, usage: res.usage, durationMs: res.durationMs };
}

// ── Test Connection / Auto Select Model (spec §6) — real, validated calls ────

export type ModelTestResult = {
  model: string;
  ok: boolean;
  httpStatus: number | null;
  errorCode: string;
  errorMessage: string;
  durationMs: number;
  outputPreview: string;
};

export type TestConnectionResult = {
  ok: boolean;
  runId: string;
  provider: AiProviderId;
  testedProvider: AiProviderId;
  model: string;
  testedModel: string;
  status: AiConnectionStatus;
  message: string;
  durationMs: number;
  errorCode?: string;
  attempts: ModelTestResult[];
  stoppedEarly: boolean;
  promotedPendingKey: boolean;
  usedUnsavedKey: boolean;
};

/**
 * Heuristic: keep only general chat/reasoning models from a live listing so
 * embedding, rerank, guard, TTS, image and similar utility endpoints are never
 * probed for a chat completion.
 */
function isChatModelId(id: string): boolean {
  return !/embed|rerank|reward|guard|safety|parse|clip|neva|vila|kosmos|deplot|fuyu|diffusion|detector|calibration|translat|retriev|tts|transcrib|robotic|computer-use|deep-research|antigravity|lyria|nano-banana|image|video|omni/i.test(id);
}

/**
 * Deterministic, BOUNDED candidate list for Test Connection / Auto Select.
 * Order: the admin's preferred model (unless retired) → catalogued recommended
 * models → live-discovered chat models (authoritative availability) → the rest
 * of the non-deprecated catalog. Retired endpoints are never included.
 */
export function selectCandidates(def: AiProviderDef, preferred: string, discovered: DiscoveredModel[] = [], max = 8): string[] {
  const retired = new Set(def.catalog.filter((m) => m.deprecated).map((m) => m.id));
  const out: string[] = [];
  const push = (id: string) => {
    const t = (id || "").trim();
    if (!t || retired.has(t) || out.includes(t)) return;
    out.push(t);
  };
  push(preferred);
  for (const m of def.catalog) if (m.recommended && !m.deprecated) push(m.id);
  for (const m of discovered) if (isChatModelId(m.id)) push(m.id);
  for (const m of def.catalog) if (!m.deprecated) push(m.id);
  return out.slice(0, max);
}

export type ProbeFn = (model: string) => Promise<GenerateOutput>;

export type CandidateWalk = { attempts: ModelTestResult[]; success: { model: string; preview: string } | null; stoppedEarly: boolean };

/**
 * Walk bounded candidates, testing each with a REAL probe. Stops at the first
 * verified success (unless testAll) and on credential/quota/rate-limit errors
 * that affect the whole key. Never reports a model as tested unless it was.
 */
export async function walkCandidates(
  candidates: string[],
  probe: ProbeFn,
  opts: { testAll?: boolean; onAttempt?: (a: ModelTestResult) => void } = {}
): Promise<CandidateWalk> {
  const attempts: ModelTestResult[] = [];
  let stoppedEarly = false;
  let success: { model: string; preview: string } | null = null;
  for (const model of candidates) {
    const at = Date.now();
    let rec: ModelTestResult;
    try {
      const out = await probe(model);
      const text = out.text.trim();
      const ok = text.length > 0;
      rec = { model, ok, httpStatus: 200, errorCode: ok ? "" : "AI_BAD_RESPONSE", errorMessage: ok ? "" : "The model returned an empty response.", durationMs: Date.now() - at, outputPreview: text.slice(0, 120) };
      if (ok) { success = { model, preview: text.slice(0, 120) }; }
    } catch (err) {
      const e = err instanceof AiHttpError ? err : new AiHttpError(502, "AI_PROVIDER_ERROR", "The AI request failed.");
      rec = { model, ok: false, httpStatus: e.status, errorCode: e.code, errorMessage: e.message, durationMs: Date.now() - at, outputPreview: "" };
    }
    attempts.push(rec);
    opts.onAttempt?.(rec);
    if (rec.ok && !opts.testAll) { stoppedEarly = true; break; }
    // Credential-wide problems: stop, do not hammer every other model.
    if (rec.errorCode === "AI_AUTH_FAILED" || rec.errorCode === "AI_QUOTA_EXCEEDED" || rec.errorCode === "AI_RATE_LIMITED") { stoppedEarly = true; break; }
  }
  return { attempts, success, stoppedEarly };
}

/**
 * Test the credential CURRENTLY ENTERED in the form (if provided) against the
 * provider, walking eligible models until one produces a validated generation.
 * Only a real HTTP success with usable output yields CONNECTED.
 */
export async function aiTestConnection(params: {
  provider: string;
  userId: string;
  userEmail: string;
  /** Unsaved key from the form — tested directly, never persisted until success. */
  apiKey?: string;
  /** Preferred model from the form. */
  preferredModel?: string;
  /** Test every candidate even after one succeeds (spec §6 — explicit only). */
  testAll?: boolean;
}): Promise<TestConnectionResult> {
  const started = Date.now();
  const runId = randomUUID();
  const def = getProviderDef(params.provider);
  if (!def) {
    return { ok: false, runId, provider: "ZAI_PLATFORM", testedProvider: "ZAI_PLATFORM", model: "", testedModel: "", status: "NOT_CONFIGURED", message: "Unknown AI provider.", durationMs: 0, errorCode: "AI_NOT_CONFIGURED", attempts: [], stoppedEarly: false, promotedPendingKey: false, usedUnsavedKey: false };
  }
  const cfg = await getGlobalConfig();
  const profile = await getProfile(def.id);
  if (!profile) {
    return { ok: false, runId, provider: def.id, testedProvider: def.id, model: "", testedModel: "", status: "NOT_CONFIGURED", message: "Provider profile not found.", durationMs: 0, errorCode: "AI_NOT_CONFIGURED", attempts: [], stoppedEarly: false, promotedPendingKey: false, usedUnsavedKey: false };
  }

  // Resolve the credential to test: form value > pending > active.
  const formKey = params.apiKey?.trim() ?? "";
  const pendingKey = profile.pendingApiKeyEnc ? decryptAiSecret(profile.pendingApiKeyEnc) : null;
  const activeKey = profile.apiKeyEnc ? decryptAiSecret(profile.apiKeyEnc) : null;
  const key = formKey || pendingKey || activeKey || "";
  const usedUnsavedKey = Boolean(formKey);
  const testingPending = !formKey && Boolean(pendingKey);

  const fail = async (code: AiErrorCode, message: string, model: string, httpStatus: number | null = null): Promise<TestConnectionResult> => {
    await db.aiProviderProfile.update({ where: { id: def.id }, data: { status: statusForError(code), lastTestedAt: new Date(), lastTestOk: false, lastErrorCode: code, lastErrorMessage: message.slice(0, 400) } });
    return { ok: false, runId, provider: def.id, testedProvider: def.id, model, testedModel: profile.testedModel, status: statusForError(code), message, durationMs: Date.now() - started, errorCode: code, attempts: [], stoppedEarly: false, promotedPendingKey: false, usedUnsavedKey };
  };

  if (!cfg.enabled) return fail("AI_DISABLED", "AI is currently disabled. Enable it before testing the connection.", params.preferredModel ?? "");
  if (def.requiresKey && !key) {
    return fail("AI_NOT_CONFIGURED", formKey ? "The entered credential could not be read." : "No credential stored. Save an API key first.", params.preferredModel ?? "");
  }

  const preferred = (params.preferredModel || profile.model || def.defaultModel).trim();

  // Refresh the candidate list from the provider's live listing API when it
  // supports one (authoritative for THIS credential); fall back to the
  // maintained catalog when discovery is unavailable. Retired models are never
  // probed. Discovery is best-effort — a failure never fails the test.
  let discovered: DiscoveredModel[] = [];
  if (def.id !== "ZAI_PLATFORM" && def.supportsDiscovery) {
    try {
      const d = await discoverModels(def.id, key, Math.min(cfg.timeoutMs, 20_000));
      if (d.ok) discovered = d.models;
    } catch { /* discovery is best-effort */ }
  }
  const candidates = selectCandidates(def, preferred, discovered);
  if (candidates.length === 0) {
    return fail("AI_MODEL_UNAVAILABLE", `${def.label} returned no eligible chat model. Load live models and pick one explicitly.`, preferred);
  }

  const walk = await walkCandidates(
    candidates,
    // 512 tokens so reasoning-style models (e.g. NVIDIA Nemotron) still emit
    // visible content after their (hidden) reasoning, avoiding false "empty".
    (model) => callProvider(def, key, model, AI_GLOBAL_SYSTEM_INSTRUCTIONS, "Reply with exactly: OK", { json: false, temperature: 0, maxTokens: 512, timeoutMs: Math.min(cfg.timeoutMs, 20_000) }),
    {
      testAll: params.testAll,
      onAttempt: (a) => { void db.aiModelTestRun.create({ data: { runId, provider: def.id, model: a.model, ok: a.ok, httpStatus: a.httpStatus, errorCode: a.errorCode, errorMessage: a.errorMessage.slice(0, 300), durationMs: a.durationMs } }).catch(() => undefined); },
    }
  );
  const attempts = walk.attempts;
  const stoppedEarly = walk.stoppedEarly;
  const success = walk.success;

  const durationMs = Date.now() - started;

  if (!success) {
    // Most actionable error across the attempted candidates (auth > quota >
    // rate limit > retired > unavailable > ...), with sanitized HTTP status.
    const rank: AiErrorCode[] = ["AI_AUTH_FAILED", "AI_QUOTA_EXCEEDED", "AI_RATE_LIMITED", "AI_MODEL_DEPRECATED", "AI_MODEL_UNAVAILABLE", "AI_SERVICE_UNAVAILABLE", "AI_TIMEOUT", "AI_PROVIDER_ERROR", "AI_BAD_RESPONSE"];
    const code = rank.find((c) => attempts.some((a) => !a.ok && a.errorCode === c)) ?? "AI_MODEL_UNAVAILABLE";
    const detail = attempts.slice(-3).map((a) => `${a.model} → ${a.errorCode}${a.httpStatus ? ` (HTTP ${a.httpStatus})` : ""}`).join("; ");
    const message = code === "AI_AUTH_FAILED"
      ? "Authentication failed. Verify the credential and its API restrictions."
      : `No eligible model connected after ${attempts.length} attempt(s). ${detail}`;
    await db.aiProviderProfile.update({ where: { id: def.id }, data: { status: statusForError(code), lastTestedAt: new Date(), lastTestOk: false, lastErrorCode: code, lastErrorMessage: message.slice(0, 400) } });
    return { ok: false, runId, provider: def.id, testedProvider: def.id, model: preferred, testedModel: profile.testedModel, status: statusForError(code), message, durationMs, errorCode: code, attempts, stoppedEarly, promotedPendingKey: false, usedUnsavedKey };
  }

  // Success — promote a pending credential (only when it was the one tested)
  // and record the exact tested model.
  let promotedPendingKey = false;
  const data: Record<string, unknown> = {
    status: "CONNECTED",
    lastTestedAt: new Date(),
    lastTestOk: true,
    lastSuccessAt: new Date(),
    lastErrorCode: "",
    lastErrorMessage: "",
    testedModel: success.model,
    updatedById: params.userId,
    updatedByEmail: params.userEmail,
  };
  if (testingPending) {
    const row = await db.aiProviderProfile.findUnique({ where: { id: def.id } });
    if (row?.pendingApiKeyEnc) {
      data.apiKeyEnc = row.pendingApiKeyEnc;
      data.apiKeyLast4 = row.pendingApiKeyLast4;
      data.apiKeySetAt = row.pendingKeySetAt ?? new Date();
      data.pendingApiKeyEnc = "";
      data.pendingApiKeyLast4 = "";
      data.pendingKeySetAt = null;
      promotedPendingKey = true;
    }
  }
  if (usedUnsavedKey && formKey && !testingPending) {
    // An unsaved key that just worked is persisted on success (spec §6.2). Any
    // other pending credential is now obsolete and must not linger, or the next
    // test would try the stale (unverified) key first.
    const prep = prepareKeyUpdate(formKey);
    data.apiKeyEnc = prep.enc;
    data.apiKeyLast4 = prep.last4;
    data.apiKeySetAt = prep.setAt;
    data.pendingApiKeyEnc = "";
    data.pendingApiKeyLast4 = "";
    data.pendingKeySetAt = null;
  }
  // Adopt the verified model (Auto Select): never leave a retired endpoint or
  // an unverified guess as the configured generation model (spec §3/§6).
  data.model = success.model;
  await db.aiProviderProfile.update({ where: { id: def.id }, data });

  const message = promotedPendingKey
    ? `New ${def.label} credential verified and activated.`
    : usedUnsavedKey
      ? `${def.label} connection successful — the entered credential was saved.`
      : `${def.label} connection successful.`;
  return { ok: true, runId, provider: def.id, testedProvider: def.id, model: success.model, testedModel: success.model, status: "CONNECTED", message, durationMs, attempts, stoppedEarly, promotedPendingKey, usedUnsavedKey };
}
