// MOHD.HMS ENTERPRISE — Letters: centralized server-side LetterGenerationService
// (§9/§10 — the ONLY place that talks to the AI provider for letters).
//
// PROMPT ARCHITECTURE (§10):
//   Template (approved AI instructions) + structured user data + letter type
//     → AI → structured draft {subject, body} → template renderer → letter.
//
// SAFETY (§9/§11/§41/§60):
//  - The AI writes ONLY the body content (and may polish the subject). It never
//    sees or alters the template structure, letterhead, logo, branding, page
//    layout or workflow state.
//  - It receives ONLY the template fields the user actually filled (ai-flagged
//    fields) — never unrelated employee records, credentials or system data.
//  - It is hard-instructed to never invent dates, reference/project numbers,
//    contract values, names, deadlines, financial figures or legal claims; the
//    caller enforces required fields BEFORE calling (§12).
//  - No API key handling here — all provider traffic goes through the central
//    AIService (Settings-managed configuration, central AI config spec §15).
//  - Never throws: returns { ok:false, error } and the route maps it to a
//    friendly structured error (same contract as the IRMS AI helper).

import "server-only";
import { aiGenerate, extractJsonObject } from "@/lib/hms/ai/service";
import { letterTypeLabel, type LetterAiAction, type TemplateField } from "./shared";
import type { TemplateContentSnapshot } from "./server";

export type GenerationResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; error: "UNAVAILABLE" | "INVALID_RESPONSE" | "EMPTY"; message: string };

const MAX_BODY_WORDS = 650;

const ACTION_INSTRUCTION: Record<LetterAiAction, string> = {
  generate: "Draft the letter body from the letter data provided.",
  regenerate: "Draft a fresh alternative version of the letter body from the letter data provided. Keep the same register and structure; vary the wording.",
  shorten: "Rewrite the CURRENT DRAFT so it is roughly half the length while preserving every factual detail exactly.",
  expand: "Rewrite the CURRENT DRAFT with appropriate professional elaboration of the points already present. Do not add any new facts.",
  formal: "Rewrite the CURRENT DRAFT in a more formal, corporate register. Preserve every factual detail exactly.",
  concise: "Rewrite the CURRENT DRAFT to be tighter and more concise. Preserve every factual detail exactly.",
  grammar: "Correct grammar, punctuation and phrasing in the CURRENT DRAFT. Preserve wording and every factual detail as far as possible.",
};

/** Strip markdown artefacts and collapse whitespace (plain prose only). */
function sanitize(raw: string): string {
  return String(raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function capWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > max ? words.slice(0, max).join(" ") + "." : text;
}

/** Only the filled ai-flagged fields travel to the provider (§41). */
function dataBlock(fields: TemplateField[], data: Record<string, string>): string {
  const lines: string[] = [];
  for (const f of fields) {
    const v = String(data[f.key] ?? "").trim();
    if (!v || !f.ai) continue;
    lines.push(`${f.label}: ${v.replace(/\s*\n\s*/g, "; ")}`);
  }
  return lines.join("\n");
}

function buildPrompt(opts: {
  action: LetterAiAction;
  snapshot: Pick<TemplateContentSnapshot, "letterType" | "aiInstructions" | "name">;
  fields: TemplateField[];
  data: Record<string, string>;
  currentSubject: string;
  currentBody: string;
}): { system: string; user: string } {
  const { action, snapshot, fields, data } = opts;
  const system =
    "You are the official letter drafting assistant for MOHD.HMS ENTERPRISE, a facility maintenance " +
    "company in Brunei Darussalam. You draft professional business correspondence.\n" +
    "ABSOLUTE RULES:\n" +
    "1. Use ONLY the facts contained in LETTER DATA. NEVER invent dates, reference numbers, project " +
    "numbers, tender numbers, contract values, amounts, names, positions, deadlines, commitments or " +
    "legal claims that are not present in the data.\n" +
    "2. Never include placeholder text such as [insert ...] or {{...}} in the output.\n" +
    "3. Never add legal disclaimers, confidentiality clauses or signature blocks — the template supplies them.\n" +
    "4. Never start the body with a salutation (Dear ...) or a closing (Yours faithfully) — the template renders those separately.\n" +
    "5. The body must be plain prose paragraphs separated by a blank line. No markdown, no headings, no bullet lists unless the data is genuinely an itemized list.\n" +
    "6. Professional corporate register, concise and factual.\n" +
    `7. The letter type is "${letterTypeLabel(snapshot.letterType)}". ${snapshot.aiInstructions ? `Template instructions (approved): ${snapshot.aiInstructions}` : ""}\n` +
    'Respond with STRICT JSON only: {"subject": "<one-line subject>", "body": "<letter body>"}. The subject must be a plain single line (no "Subject:" prefix).';

  const userData = dataBlock(fields, data);
  const isRewrite = action !== "generate" && action !== "regenerate";
  const user =
    `TASK: ${ACTION_INSTRUCTION[action]}\n\n` +
    (isRewrite
      ? `CURRENT SUBJECT: ${opts.currentSubject || "(none)"}\n\nCURRENT DRAFT:\n${opts.currentBody}\n\n`
      : "") +
    `LETTER DATA (the only facts you may use):\n${userData || "(none provided)"}\n\n` +
    "Return the JSON object now.";

  return { system, user };
}

/**
 * Generate (or transform) a letter draft. Deterministic template structure is
 * untouched — the caller applies the returned subject/body to the draft only.
 */
export async function generateLetterContent(opts: {
  action: LetterAiAction;
  snapshot: Pick<TemplateContentSnapshot, "letterType" | "aiInstructions" | "name">;
  fields: TemplateField[];
  data: Record<string, string>;
  currentSubject: string;
  currentBody: string;
}): Promise<GenerationResult> {
  const { system, user } = buildPrompt(opts);
  try {
    const res = await aiGenerate({ feature: "letter_draft", system, prompt: user });
    if (!res.ok) {
      const message =
        res.code === "AI_DISABLED"
          ? "AI is currently disabled by the administrator. Write the letter manually or contact an administrator."
          : res.code === "AI_NOT_CONFIGURED"
            ? "AI service is not configured. Write the letter manually or contact an administrator."
            : res.code === "AI_RATE_LIMITED"
              ? "Too many AI requests. Please wait a moment and try again, or write the letter manually."
              : "The AI assistant is unavailable right now. Please try again in a moment, or write the letter manually.";
      return { ok: false, error: "UNAVAILABLE", message };
    }
    const obj = extractJsonObject(res.text);
    if (!obj) {
      return { ok: false, error: "INVALID_RESPONSE", message: "The AI response could not be interpreted. Please try again." };
    }
    const subject = sanitize(String(obj.subject ?? "")).replace(/^[Ss]ubject\s*:\s*/, "").slice(0, 300);
    let body = sanitize(String(obj.body ?? ""));
    // The body must never leak placeholder tokens — strip any leftovers.
    body = body.replace(/\{\{[A-Z0-9_]+\}\}/g, "").trim();
    // The salutation and closing are template-owned structure — drop a leading
    // "Dear ..." line or a trailing "Yours faithfully" line if the model added
    // them despite the instruction (defense in depth, §11).
    body = body.replace(/^dear\b[^,\n]{0,80},?\s*\n+/i, "").trim();
    body = body.replace(/\n+\s*(yours (faithfully|sincerely)|sincerely|best regards|regards)[^\n]*\n?\s*$/i, "").trim();
    body = capWords(body, MAX_BODY_WORDS);
    if (!body) {
      return { ok: false, error: "EMPTY", message: "The AI returned an empty draft. Please try again or write the letter manually." };
    }
    return { ok: true, subject, body };
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "letter-ai-generate-failed",
        action: opts.action,
        err: err instanceof Error ? err.message : String(err),
      })
    );
    return { ok: false, error: "UNAVAILABLE", message: "The AI assistant is unavailable right now. Please try again in a moment, or write the letter manually." };
  }
}
