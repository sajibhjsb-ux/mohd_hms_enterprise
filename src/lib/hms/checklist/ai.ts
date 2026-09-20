// MOHD.HMS ENTERPRISE — Checklist engine AI caller (z-ai-web-dev-sdk, server-only).
// Spec §39: API keys stay server-side (the SDK handles credentials); §71: this is
// a REAL provider call — there is no hardcoded-template fake behind it. The
// function never throws; failures come back as {ok:false} so the engine can fall
// back to an approved template (§72) or ask for manual creation (§73).

import "server-only";
import ZAI from "z-ai-web-dev-sdk";

export type AiCallResult =
  | { ok: true; raw: unknown; model: string }
  | { ok: false; error: string };

/** Extract the first balanced JSON object from a model response (letters/generation.ts pattern). */
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

/**
 * Call the configured AI provider with the checklist generation prompt.
 * Returns the parsed JSON object or a friendly failure reason (never raw
 * provider errors — spec §70: no stack traces / parsing errors reach users).
 */
export async function callChecklistAi(system: string, user: string): Promise<AiCallResult> {
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: system },
        { role: "user", content: user },
      ],
      thinking: { type: "disabled" },
    });
    const text = completion.choices[0]?.message?.content ?? "";
    const parsed = extractJsonObject(text);
    if (!parsed) {
      return { ok: false, error: "AI returned an unusable response format." };
    }
    return { ok: true, raw: parsed, model: "z-ai-chat" };
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "checklist-ai-generate-failed",
        err: err instanceof Error ? err.message : String(err),
      })
    );
    return { ok: false, error: "AI generation is temporarily unavailable." };
  }
}

/**
 * §30/§63 — post-execution AI summary. Derived ONLY from actual recorded
 * checklist results; the prompt forbids invention. Returns null on failure.
 */
export async function callChecklistSummaryAi(system: string, user: string): Promise<string | null> {
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: system },
        { role: "user", content: user },
      ],
      thinking: { type: "disabled" },
    });
    const text = String(completion.choices[0]?.message?.content ?? "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^#+\s*/gm, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 0 ? text.slice(0, 1200) : null;
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "checklist-ai-summary-failed",
        err: err instanceof Error ? err.message : String(err),
      })
    );
    return null;
  }
}
