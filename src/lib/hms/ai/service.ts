// MOHD.HMS ENTERPRISE — CENTRAL AI SERVICE (server-only).
// Central AI configuration spec §9/§10/§14/§28: this is the ONE backend AI
// service in the application. Every AI-powered module (ChecklistService,
// IRMS, Letters/HR, Quotation/Report assistants, ...) calls THIS service —
// no module may initialize its own provider client or hold its own key.
//
//   Browser → Next.js API route → AIService (here) → provider API
//
// Responsibilities (spec §10): credential retrieval + decryption, provider
// selection, model selection, global system instructions, timeouts, limited
// retries with backoff, rate limiting, API error normalization (never leaks
// the credential), structured output validation, usage tracking (safe
// metadata only), honest failure states (spec §34 — never fake success).

import "server-only";
import { randomUUID } from "crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { decryptAiSecret, encryptAiSecret } from "./crypto";

// ── Providers (spec §2 — Google Gemini first-class; the built-in platform AI
//    is the pre-existing provider so existing features keep working; the
//    architecture allows more providers later without touching features). ──

export const AI_PROVIDERS = [
  { id: "ZAI_PLATFORM", label: "Built-in Z.ai Platform", requiresKey: false, hint: "Platform-managed AI — no external credential required." },
  { id: "GOOGLE_GEMINI", label: "Google Gemini", requiresKey: true, hint: "Gemini API credential entered by the administrator, stored encrypted server-side." },
] as const;

export type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];
export const AI_DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export type AiErrorCode =
  | "AI_DISABLED"
  | "AI_NOT_CONFIGURED"
  | "AI_RATE_LIMITED"
  | "AI_AUTH_FAILED"
  | "AI_TIMEOUT"
  | "AI_PROVIDER_ERROR"
  | "AI_BAD_RESPONSE";

export type AiUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };

export type AiTextResult =
  | { ok: true; text: string; provider: string; model: string; requestId: string; usage: AiUsage; durationMs: number }
  | { ok: false; code: AiErrorCode; message: string; provider: string; model: string; requestId: string; durationMs: number };

export type AiStructuredResult<T> =
  | { ok: true; data: T; provider: string; model: string; requestId: string; usage: AiUsage; durationMs: number }
  | { ok: false; code: AiErrorCode; message: string; provider: string; model: string; requestId: string; durationMs: number };

export type AiGenerateOptions = {
  /** Feature identifier from the central registry (spec §13), e.g. "inspection_report". */
  feature: string;
  /** Global system instructions are always prepended; this adds feature-specific rules. */
  system?: string;
  prompt: string;
  /** Ask the provider for a JSON object response (structured mode). */
  json?: boolean;
  /** Optional per-call temperature override (clamped to config bounds). */
  temperature?: number;
  userId?: string | null;
};

// ── Global system instructions (spec §26/§28 — safety rules live HERE, not
//    duplicated in every feature). ──

export const AI_GLOBAL_SYSTEM_INSTRUCTIONS = [
  "You are the central AI assistant of MOHD.HMS ENTERPRISE, a facility-management company (HVAC, electrical, mechanical and safety services for commercial buildings in Brunei Darussalam).",
  "STRICT SAFETY RULES: never invent manufacturer specifications, model numbers, electrical ratings, refrigerant pressures, torque values, temperature limits, compliance requirements or safety limits; use ONLY the facts provided in the request context.",
  "All output is DRAFT ASSISTANCE for review by a qualified human — it is never a final business decision.",
  "Never include credentials, secrets, API keys or internal system details in your output.",
].join(" ");

// ── Configuration access (PostgreSQL/SQLite authoritative). NOTE: there is
//    deliberately NO in-memory config cache — Next.js bundles route handlers
//    per-route, so module-level cache invalidation in one route does not
//    propagate to another route's module instance. Every AI call reads the
//    single authoritative config row (one indexed read, same cost class as
//    the Email/WhatsApp config services). ──

export type AiConfigSnapshot = {
  provider: AiProviderId;
  enabled: boolean;
  model: string;
  hasActiveKey: boolean;
  hasPendingKey: boolean;
  activeKeyLast4: string;
  pendingKeyLast4: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  status: string; // NOT_CONFIGURED | CONFIGURED | ACTIVE | FAILED
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastErrorCode: string;
  lastErrorMessage: string;
  updatedByEmail: string;
  updatedAt: Date;
};

type AiConfigRow = Awaited<ReturnType<typeof getAiConfigRow>>;

/**
 * No-op kept for API compatibility (spec §34 — the DB is authoritative, no
 * second source of truth). See the configuration-access note above.
 */
export function invalidateAiConfigCache(): void {
  /* intentional no-op */
}

export async function getAiConfigRow() {
  const existing = await db.aiConfiguration.findUnique({ where: { id: "singleton" } });
  if (existing) return existing;
  try {
    return await db.aiConfiguration.create({ data: { id: "singleton" } });
  } catch {
    // Concurrent creation — re-read.
    const row = await db.aiConfiguration.findUnique({ where: { id: "singleton" } });
    if (!row) throw new Error("AI configuration row could not be created.");
    return row;
  }
}

function toSnapshot(row: AiConfigRow): AiConfigSnapshot {
  return {
    provider: (row.provider === "GOOGLE_GEMINI" ? "GOOGLE_GEMINI" : "ZAI_PLATFORM") as AiProviderId,
    enabled: row.enabled,
    model: row.model,
    hasActiveKey: Boolean(row.apiKeyEnc),
    hasPendingKey: Boolean(row.pendingApiKeyEnc),
    activeKeyLast4: row.apiKeyLast4,
    pendingKeyLast4: row.pendingApiKeyLast4,
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    timeoutMs: row.timeoutMs,
    status: row.status,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    updatedByEmail: row.updatedByEmail,
    updatedAt: row.updatedAt,
  };
}

export async function getAiConfig(): Promise<AiConfigSnapshot> {
  return toSnapshot(await getAiConfigRow());
}

// ── Rate limiting (spec §23). The sandbox has no Redis; per the project's
//    caching policy a local in-memory sliding window is used. The window is
//    per server-module instance (protective, not authoritative — the honest
//    behavior never depends on it). Keys never contain credentials. ──

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

// ── Honest gating (spec §18/§19) ──

function gateFailure(cfg: AiConfigSnapshot): { code: AiErrorCode; message: string } | null {
  if (!cfg.enabled) {
    return { code: "AI_DISABLED", message: "AI service is currently disabled by the administrator." };
  }
  if (cfg.provider === "GOOGLE_GEMINI" && !cfg.hasActiveKey) {
    return { code: "AI_NOT_CONFIGURED", message: "AI service is not configured. Please contact an administrator." };
  }
  return null;
}

// ── Usage logging (spec §22 — safe metadata only; never the key, never the
//    raw prompt; single choke point so every caller is tracked). ──

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
    // Usage logging must never break the AI response path.
  }
}

// ── Provider: built-in Z.ai platform (the pre-existing SDK path). ──

type ZaiCompletion = { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };

function openAiUsage(c: ZaiCompletion): AiUsage {
  const input = typeof c.usage?.prompt_tokens === "number" ? c.usage.prompt_tokens : null;
  const output = typeof c.usage?.completion_tokens === "number" ? c.usage.completion_tokens : null;
  const total = typeof c.usage?.total_tokens === "number" ? c.usage.total_tokens : input !== null && output !== null ? input + output : null;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

async function callZaiPlatform(cfg: AiConfigSnapshot, opts: AiGenerateOptions, system: string, user: string): Promise<{ text: string; usage: AiUsage; model: string }> {
  const { default: ZAI } = await import("z-ai-web-dev-sdk");
  const zai = await ZAI.create();
  const completion = (await Promise.race([
    zai.chat.completions.create({
      messages: [
        { role: "assistant", content: system },
        { role: "user", content: user },
      ],
      thinking: { type: "disabled" },
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AI_TIMEOUT")), cfg.timeoutMs)),
  ])) as ZaiCompletion;
  return {
    text: String(completion.choices?.[0]?.message?.content ?? ""),
    usage: openAiUsage(completion),
    model: "z-ai-chat",
  };
}

// ── Provider: Google Gemini REST (current v1beta generateContent endpoint).
//    The credential travels ONLY in the x-goog-api-key header — never in the
//    URL/query, never in the body, never logged (spec §3/§11). This header
//    works for both standard and authorization keys, so the implementation
//    makes no assumption about a specific key format (spec §35). ──

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};

class GeminiHttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function mapGeminiStatus(status: number, providerCode: string): { code: AiErrorCode; message: string } {
  if (status === 401 || status === 403) {
    return { code: "AI_AUTH_FAILED", message: "Authentication failed. Please verify the AI credential and its API restrictions in Settings → AI." };
  }
  if (status === 429) {
    return { code: "AI_RATE_LIMITED", message: "The AI provider is rate limiting requests. Please wait a moment and try again." };
  }
  if (status === 404) {
    return { code: "AI_PROVIDER_ERROR", message: "The configured AI model was not found. Check the model name in Settings → AI." };
  }
  if (status === 400) {
    return { code: "AI_PROVIDER_ERROR", message: "The AI request was rejected. Check the model name and configuration in Settings → AI." };
  }
  return { code: "AI_PROVIDER_ERROR", message: "The AI provider reported a temporary problem. Please try again." };
}

/**
 * Google reports invalid credentials in different shapes depending on key
 * type (standard vs authorization) — always as a 400/401/403 whose message
 * or status mentions the key. Detect it from BOTH so the user always gets
 * the actionable "verify your credential" error (spec §16/§24).
 */
function isCredentialRejection(status: number, providerStatus: string, providerMessage: string): boolean {
  const haystack = `${providerStatus} ${providerMessage}`.toUpperCase();
  return (
    status === 401 ||
    status === 403 ||
    haystack.includes("API_KEY") ||
    haystack.includes("API KEY") ||
    haystack.includes("PERMISSION_DENIED") ||
    haystack.includes("UNAUTHENTICATED")
  );
}

async function callGemini(cfg: AiConfigSnapshot, apiKey: string, opts: AiGenerateOptions, system: string, user: string): Promise<{ text: string; usage: AiUsage; model: string }> {
  const model = cfg.model.trim() || AI_DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const temperature = Math.min(2, Math.max(0, opts.temperature ?? cfg.temperature));
  const body = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      temperature,
      maxOutputTokens: cfg.maxOutputTokens,
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    },
  };

  const maxRetries = 2; // spec §24 — limited, exponential backoff, retryable only
  let lastErr: { code: AiErrorCode; message: string } | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as GeminiResponse;
        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        const u = json.usageMetadata ?? {};
        return {
          text,
          usage: {
            inputTokens: u.promptTokenCount ?? null,
            outputTokens: u.candidatesTokenCount ?? null,
            totalTokens: u.totalTokenCount ?? null,
          },
          model,
        };
      }
      let providerCode = "";
      let providerMessage = "";
      try {
        const errJson = (await res.json()) as { error?: { status?: string; message?: string } };
        providerCode = errJson.error?.status ?? "";
        providerMessage = errJson.error?.message ?? "";
      } catch {
        // Body parse failure — fall through to status mapping.
      }
      const mapped = isCredentialRejection(res.status, providerCode, providerMessage)
        ? { code: "AI_AUTH_FAILED" as const, message: "Authentication failed. Please verify the AI credential and its API restrictions in Settings → AI." }
        : mapGeminiStatus(res.status, providerCode);
      // Retry ONLY what is reasonably retryable (429 / 5xx / network); never
      // retry auth failures, invalid requests or unsupported models (spec §24).
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = mapped;
      if (!retryable || attempt === maxRetries) throw new GeminiHttpError(res.status, mapped.code, mapped.message);
    } catch (err) {
      if (err instanceof GeminiHttpError) throw err;
      const timedOut = err instanceof Error && (err.name === "AbortError" || err.message === "AI_TIMEOUT");
      lastErr = timedOut
        ? { code: "AI_TIMEOUT", message: "The AI request timed out. Please try again." }
        : { code: "AI_PROVIDER_ERROR", message: "The AI provider could not be reached. Please try again." };
      const retryable = timedOut || !(err instanceof Error && "status" in err);
      if (!retryable || attempt === maxRetries) {
        throw new GeminiHttpError(timedOut ? 504 : 502, lastErr.code, lastErr.message);
      }
    } finally {
      clearTimeout(timer);
    }
    // Exponential backoff: 800ms, 1600ms.
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
  }
  throw new GeminiHttpError(502, lastErr?.code ?? "AI_PROVIDER_ERROR", lastErr?.message ?? "The AI request failed.");
}

// ── Core text generation (single choke point — spec §9/§14) ──

function buildMessages(opts: AiGenerateOptions): { system: string; user: string } {
  const system = opts.system
    ? `${AI_GLOBAL_SYSTEM_INSTRUCTIONS}\n\n${opts.system}`
    : AI_GLOBAL_SYSTEM_INSTRUCTIONS;
  return { system, user: opts.prompt };
}

export async function aiGenerate(opts: AiGenerateOptions): Promise<AiTextResult> {
  const requestId = randomUUID();
  const started = Date.now();
  const cfg = await getAiConfig();
  const cfgModel = cfg.provider === "GOOGLE_GEMINI" ? cfg.model.trim() || AI_DEFAULT_GEMINI_MODEL : "z-ai-chat";

  const fail = (code: AiErrorCode, message: string, status: "FAILED" | "REJECTED"): AiTextResult => {
    const durationMs = Date.now() - started;
    void logUsage({ userId: opts.userId, feature: opts.feature, requestId, provider: cfg.provider, model: cfgModel, status, durationMs, errorCode: code });
    return { ok: false, code, message, provider: cfg.provider, model: cfgModel, requestId, durationMs };
  };

  // Rate limiting FIRST (spec §23) — even policy-rejected requests consume
  // protection budget so a client cannot bypass the limiter via gating.
  if (opts.userId && !allowRate(`user:${opts.userId}`, RATE_LIMIT_PER_USER)) {
    return fail("AI_RATE_LIMITED", "Too many AI requests. Please wait a moment and try again.", "REJECTED");
  }
  if (!allowRate("global", RATE_LIMIT_GLOBAL)) {
    return fail("AI_RATE_LIMITED", "The AI service is busy. Please wait a moment and try again.", "REJECTED");
  }

  // Policy gates (spec §18/§19) — honest rejections, no fake output.
  const gate = gateFailure(cfg);
  if (gate) return fail(gate.code, gate.message, "REJECTED");

  const { system, user } = buildMessages(opts);
  try {
    let out: { text: string; usage: AiUsage; model: string };
    if (cfg.provider === "GOOGLE_GEMINI") {
      const key = decryptAiSecret((await getAiConfigRow()).apiKeyEnc);
      if (!key) return fail("AI_NOT_CONFIGURED", "The stored AI credential could not be read. Please re-save it in Settings → AI.", "FAILED");
      out = await callGemini(cfg, key, opts, system, user);
    } else {
      out = await callZaiPlatform(cfg, opts, system, user);
    }
    const text = out.text.trim();
    if (!text) return fail("AI_BAD_RESPONSE", "The AI returned an empty response. Please try again.", "FAILED");
    const durationMs = Date.now() - started;
    void logUsage({ userId: opts.userId, feature: opts.feature, requestId, provider: cfg.provider, model: out.model, status: "SUCCESS", durationMs, usage: out.usage });
    return { ok: true, text, provider: cfg.provider, model: out.model, requestId, usage: out.usage, durationMs };
  } catch (err) {
    if (err instanceof GeminiHttpError) return fail(err.code as AiErrorCode, err.message, "FAILED");
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "ai-service-generate-failed",
        feature: opts.feature,
        provider: cfg.provider,
        err: err instanceof Error ? err.message : String(err),
      })
    );
    return fail("AI_PROVIDER_ERROR", "AI generation failed. Please try again.", "FAILED");
  }
}

// ── JSON extraction (consolidated — was duplicated in letters/generation.ts
//    and checklist/ai.ts; spec §15). Extracts the first balanced JSON object. ──

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

// ── Structured generation with backend schema validation (spec §25) —
//    malformed AI output can never reach business records. ──

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

// ── Connection test (spec §16/§17) — a REAL authenticated provider request,
//    never just a non-empty check. Handles key rotation: tests the pending
//    credential first and only promotes it after success, keeping the old
//    working credential untouched on failure. ──

export async function aiTestConnection(params: { userId: string; userEmail: string }): Promise<{ ok: boolean; message: string; provider: string; model: string; durationMs: number; errorCode?: string }> {
  const started = Date.now();
  const row = await getAiConfigRow();
  const cfg = toSnapshot(row);
  const provider = cfg.provider;

  if (!cfg.enabled) {
    return { ok: false, message: "AI is currently disabled. Enable it before testing the connection.", provider, model: cfg.model || "-", durationMs: Date.now() - started, errorCode: "AI_DISABLED" };
  }

  try {
    if (provider === "GOOGLE_GEMINI") {
      const testingPending = cfg.hasPendingKey;
      const cipher = testingPending ? row.pendingApiKeyEnc : row.apiKeyEnc;
      const key = decryptAiSecret(cipher);
      if (!key) {
        return { ok: false, message: testingPending ? "The newly entered credential could not be read. Please re-enter it." : "No Gemini credential is stored. Enter and save an API key first.", provider, model: cfg.model || AI_DEFAULT_GEMINI_MODEL, durationMs: Date.now() - started, errorCode: "AI_NOT_CONFIGURED" };
      }
      const model = cfg.model.trim() || AI_DEFAULT_GEMINI_MODEL;
      const probe: AiGenerateOptions = { feature: "connection_test", prompt: "Reply with exactly: OK", temperature: 0, json: false };
      const out = await callGemini({ ...cfg, model, maxOutputTokens: 64 }, key, probe, AI_GLOBAL_SYSTEM_INSTRUCTIONS, probe.prompt);
      const text = out.text.trim().toUpperCase();
      if (!text) {
        await markTest(row.id, false, "AI_BAD_RESPONSE", "The AI provider returned an empty response.", params);
        return { ok: false, message: "The AI provider returned an empty response.", provider, model, durationMs: Date.now() - started, errorCode: "AI_BAD_RESPONSE" };
      }
      if (testingPending) await promotePendingKey(row.id);
      await markTest(row.id, true, "", "", params, model);
      return { ok: true, message: testingPending ? "New Gemini credential verified and activated." : "Gemini connection successful.", provider, model, durationMs: Date.now() - started };
    }

    // ZAI_PLATFORM — real platform call. NOTE: the model column is NOT
    // touched here — it stores the administrator's Gemini model choice and
    // must survive a platform-provider test unchanged.
    const probe: AiGenerateOptions = { feature: "connection_test", prompt: "Reply with exactly: OK", temperature: 0, json: false };
    const out = await callZaiPlatform(cfg, probe, AI_GLOBAL_SYSTEM_INSTRUCTIONS, probe.prompt);
    if (!out.text.trim()) {
      await markTest(row.id, false, "AI_BAD_RESPONSE", "The AI platform returned an empty response.", params);
      return { ok: false, message: "The AI platform returned an empty response.", provider, model: "z-ai-chat", durationMs: Date.now() - started, errorCode: "AI_BAD_RESPONSE" };
    }
    await markTest(row.id, true, "", "", params);
    return { ok: true, message: "AI platform connection successful.", provider, model: "z-ai-chat", durationMs: Date.now() - started };
  } catch (err) {
    const code = err instanceof GeminiHttpError ? (err.code as string) : "AI_PROVIDER_ERROR";
    const message = err instanceof GeminiHttpError ? err.message : "The AI provider could not be reached. Please try again.";
    await markTest(row.id, false, code, message, params);
    return { ok: false, message, provider, model: cfg.model || (provider === "GOOGLE_GEMINI" ? AI_DEFAULT_GEMINI_MODEL : "z-ai-chat"), durationMs: Date.now() - started, errorCode: code };
  }
}

async function markTest(configId: string, ok: boolean, errorCode: string, errorMessage: string, params: { userId: string; userEmail: string }, model?: string): Promise<void> {
  await db.aiConfiguration.update({
    where: { id: configId },
    data: {
      status: ok ? "ACTIVE" : "FAILED",
      lastTestedAt: new Date(),
      lastTestOk: ok,
      lastErrorCode: ok ? "" : errorCode,
      lastErrorMessage: ok ? "" : errorMessage,
      ...(model !== undefined ? { model } : {}),
      updatedById: params.userId,
      updatedByEmail: params.userEmail,
    },
  });
  invalidateAiConfigCache();
}

async function promotePendingKey(configId: string): Promise<void> {
  const row = await db.aiConfiguration.findUnique({ where: { id: configId } });
  if (!row || !row.pendingApiKeyEnc) return;
  await db.aiConfiguration.update({
    where: { id: configId },
    data: {
      apiKeyEnc: row.pendingApiKeyEnc,
      apiKeyLast4: row.pendingApiKeyLast4,
      apiKeySetAt: row.pendingKeySetAt ?? new Date(),
      pendingApiKeyEnc: "",
      pendingApiKeyLast4: "",
      pendingKeySetAt: null,
    },
  });
  invalidateAiConfigCache();
}

// ── Credential write helpers (used by the Settings AI API; spec §5/§17). ──

export function prepareKeyUpdate(plainKey: string): { enc: string; last4: string; setAt: Date } {
  const trimmed = plainKey.trim();
  return {
    enc: encryptAiSecret(trimmed),
    last4: trimmed.slice(-4),
    setAt: new Date(),
  };
}

export function isRetryableAiCode(code: string): boolean {
  return code === "AI_RATE_LIMITED" || code === "AI_PROVIDER_ERROR" || code === "AI_TIMEOUT";
}
