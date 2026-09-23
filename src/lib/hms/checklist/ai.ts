// MOHD.HMS ENTERPRISE — Checklist engine AI caller (server-only).
// CENTRAL AI CONFIG SPEC §15/§27: this module no longer initializes its own
// provider client. ALL provider traffic goes through the central AIService
// (src/lib/hms/ai/service.ts), which loads the Settings-managed configuration
// (provider, encrypted credential, model), enforces gating/rate limits and
// records usage metadata. This file keeps its original contract so the
// checklist engine is untouched apart from richer provider metadata.
//
// Spec §39: API keys stay server-side; §71: this is a REAL provider call —
// there is no hardcoded-template fake behind it. Failures come back as
// {ok:false} so the engine can fall back to an approved template (§72) or ask
// for manual creation (§73).

import "server-only";
import { aiGenerate, extractJsonObject } from "@/lib/hms/ai/service";

// Consolidated JSON extraction (previously duplicated here and in
// letters/generation.ts) — re-exported for backward compatibility.
export { extractJsonObject };

export type AiCallResult =
  | { ok: true; raw: unknown; model: string; provider: string }
  | { ok: false; error: string };

/** Map central AIService failure codes to honest, user-safe messages. */
function friendlyAiError(code: string): string {
  switch (code) {
    case "AI_DISABLED":
      return "AI is currently disabled by the administrator.";
    case "AI_NOT_CONFIGURED":
      return "AI service is not configured. Please contact an administrator.";
    case "AI_RATE_LIMITED":
      return "Too many AI requests. Please wait a moment and try again.";
    default:
      return "AI generation is temporarily unavailable.";
  }
}

/**
 * Call the central AIService with the checklist generation prompt.
 * Returns the parsed JSON object or a friendly failure reason (never raw
 * provider errors — spec §70: no stack traces / parsing errors reach users).
 */
export async function callChecklistAi(system: string, user: string): Promise<AiCallResult> {
  const res = await aiGenerate({ feature: "checklist_generation", system, prompt: user, json: true });
  if (!res.ok) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "checklist-ai-generate-failed",
        code: res.code,
      })
    );
    return { ok: false, error: friendlyAiError(res.code) };
  }
  const parsed = extractJsonObject(res.text);
  if (!parsed) {
    return { ok: false, error: "AI returned an unusable response format." };
  }
  return { ok: true, raw: parsed, model: res.model, provider: res.provider };
}

/**
 * §30/§63 — post-execution AI summary. Derived ONLY from actual recorded
 * checklist results; the prompt forbids invention. Returns null on failure.
 */
export async function callChecklistSummaryAi(system: string, user: string): Promise<string | null> {
  const res = await aiGenerate({ feature: "checklist_summary", system, prompt: user });
  if (!res.ok) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "checklist-ai-summary-failed",
        code: res.code,
      })
    );
    return null;
  }
  const text = res.text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text.slice(0, 1200) : null;
}
