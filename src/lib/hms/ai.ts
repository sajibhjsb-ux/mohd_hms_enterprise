// MOHD.HMS ENTERPRISE — server-only AI helper for IRMS (z-ai-web-dev-sdk).
//
// DISCLAIMER / GUARDRAILS (contract §15 / spec §10):
//  - Output is DRAFT ASSISTANCE ONLY. Staff preview it in the UI and must insert
//    it explicitly; nothing is ever auto-saved.
//  - The model is instructed to write ONLY from the provided inspection context —
//    no fabricated facts, no invented measurements, no invented customer names.
//  - generateInspectionText() NEVER throws: on any failure it returns null and
//    the caller decides the error response (friendly 502-style ApiError).

import "server-only";
import ZAI from "z-ai-web-dev-sdk";

export const AI_FIELDS = ["remarks", "correctiveAction", "recommendation", "summary", "safetyNotes", "rootCause"] as const;
export type AiField = (typeof AI_FIELDS)[number];

export type AiContext = {
  title?: string;
  type?: string;
  overallCondition?: string;
  findings?: { finding?: string; severity?: string; recommendation?: string }[];
  scope?: string;
  equipment?: string;
  project?: string;
  hint?: string;
};

const FIELD_LABEL: Record<AiField, string> = {
  remarks: "general remarks",
  correctiveAction: "corrective actions taken",
  recommendation: "recommendations",
  summary: "executive summary",
  safetyNotes: "safety notes",
  rootCause: "root cause analysis",
};

const MAX_WORDS = 180;

function contextBlock(ctx: AiContext): string {
  const lines: string[] = [];
  if (ctx.title) lines.push(`Report title: ${ctx.title}`);
  if (ctx.type) lines.push(`Inspection type: ${ctx.type}`);
  if (ctx.project) lines.push(`Project/site: ${ctx.project}`);
  if (ctx.equipment) lines.push(`Equipment: ${ctx.equipment}`);
  if (ctx.overallCondition) lines.push(`Overall condition: ${ctx.overallCondition}`);
  if (ctx.scope) lines.push(`Scope of work: ${ctx.scope}`);
  if (ctx.findings?.length) {
    lines.push("Findings:");
    for (const f of ctx.findings.slice(0, 12)) {
      const parts = [f.finding, f.severity ? `severity ${f.severity}` : "", f.recommendation ? `recommendation: ${f.recommendation}` : ""].filter(Boolean);
      if (parts.length) lines.push(`- ${parts.join("; ")}`);
    }
  }
  if (ctx.hint) lines.push(`Extra guidance from the inspector: ${ctx.hint}`);
  return lines.join("\n");
}

/** Strip markdown artefacts, collapse whitespace, hard-cap the word count. */
function sanitize(raw: string): string {
  let text = String(raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > MAX_WORDS) text = words.slice(0, MAX_WORDS).join(" ") + ".";
  return text;
}

/**
 * Generate professional inspection-report prose for one field.
 * Returns null on any failure — never throws (caller maps to a friendly error).
 */
export async function generateInspectionText(field: AiField, context: AiContext): Promise<string | null> {
  const system =
    "You are a senior facility-maintenance inspection report writer for MOHD.HMS ENTERPRISE " +
    "(HVAC, electrical, mechanical and safety inspections for commercial buildings in Brunei Darussalam). " +
    "Write the requested section in a professional, factual inspection-report tone. " +
    "Strict rules: use ONLY the facts provided in the inspection context — never invent measurements, " +
    "names, dates, quantities or defects that are not stated; do not add legal advice or disclaimers; " +
    `keep it under ${MAX_WORDS} words; output plain prose (no markdown, no headings, no bullet lists ` +
    "unless the content is genuinely a list).";
  const user =
    `Write the ${FIELD_LABEL[field]} section for this inspection report.\n\n` +
    `Inspection context:\n${contextBlock(context) || "(no context provided — write a neutral, professional placeholder-free opening that the inspector can complete)"}`;

  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: system },
        { role: "user", content: user },
      ],
      thinking: { type: "disabled" },
    });
    const text = sanitize(completion.choices[0]?.message?.content ?? "");
    return text.length > 0 ? text : null;
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "irms-ai-generate-failed",
        field,
        err: err instanceof Error ? err.message : String(err),
      })
    );
    return null;
  }
}
