// MOHD.HMS ENTERPRISE — Central AI feature registry (spec §13/§28).
// Every AI request identifies the feature that requested it. The registry
// binds each feature to: the RBAC permission required to use it, its prompt
// rules, and (for structured features) the backend output schema validated
// with Zod before any business record is touched (spec §25).
//
// Feature-specific PROMPTS live here; infrastructure concerns (credentials,
// provider calls, retries, rate limits, logging) live exclusively in the
// central AIService (./service.ts) — never duplicated per feature (spec §28).

import "server-only";
import { z } from "zod";
import type { Permission } from "@/lib/hms/constants";

export type AiFeatureKind = "text" | "structured";

export type AiFeatureDef = {
  id: string;
  label: string;
  kind: AiFeatureKind;
  /** RBAC permission required to invoke this feature (backend-enforced). */
  permission: Permission;
  /** Hard cap for client-supplied prompt length (spec §12/§23 abuse guard). */
  maxPromptChars: number;
  /** Feature-specific system instructions (merged after the global rules). */
  system?: string;
  /**
   * Structured features build their prompt SERVER-SIDE from validated
   * context — the client cannot inject arbitrary prompts (spec §25).
   */
  buildPrompt?: (ctx: Record<string, string>) => string;
  /** Structured output schema (Zod) validated before use (spec §25). */
  schema?: z.ZodTypeAny;
};

/** Flatten a validated string context into a bounded prompt block. */
export function aiContextBlock(ctx: Record<string, unknown> | undefined, maxEntries = 12, maxValueChars = 400): string {
  if (!ctx) return "";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(ctx)) {
    if (lines.length >= maxEntries) break;
    if (value === null || value === undefined) continue;
    const str = String(value).replace(/[\u0000-\u001f]+/g, " ").trim();
    if (!str) continue;
    lines.push(`${key}: ${str.slice(0, maxValueChars)}`);
  }
  return lines.length ? `\n\nContext:\n${lines.join("\n")}` : "";
}

const PROFESSIONAL_TONE = "Write in a professional, factual facility-services tone suitable for customer-facing business documents.";

export const AI_FEATURES: Record<string, AiFeatureDef> = {
  // ── Text features (client supplies the request text + bounded context) ──
  quotation_description: {
    id: "quotation_description",
    label: "Quotation description",
    kind: "text",
    permission: "quotations.manage",
    maxPromptChars: 4000,
    system: `You draft quotation work descriptions for facility-maintenance quotations.${PROFESSIONAL_TONE} Output plain prose only — no markdown, no headings.`,
  },
  invoice_description: {
    id: "invoice_description",
    label: "Invoice description",
    kind: "text",
    permission: "invoices.manage",
    maxPromptChars: 4000,
    system: `You draft invoice line descriptions for completed facility-maintenance work.${PROFESSIONAL_TONE} Output plain prose only.`,
  },
  complaint_summary: {
    id: "complaint_summary",
    label: "Complaint summary",
    kind: "text",
    permission: "complaints.update",
    maxPromptChars: 4000,
    system: "You summarize customer complaints for facility-management staff. Be neutral, factual and concise; never assign blame; use only the provided facts.",
  },
  work_order_summary: {
    id: "work_order_summary",
    label: "Work order summary",
    kind: "text",
    permission: "work_orders.update",
    maxPromptChars: 4000,
    system: "You summarize facility-maintenance work orders for staff handovers. Use only the provided facts; keep it under 180 words; plain prose.",
  },
  email_draft: {
    id: "email_draft",
    label: "Email draft",
    kind: "text",
    permission: "email.client",
    maxPromptChars: 4000,
    system: `You draft professional business emails for MOHD.HMS ENTERPRISE staff.${PROFESSIONAL_TONE} Never invent commitments, dates, prices or contractual terms.`,
  },
  report_summary: {
    id: "report_summary",
    label: "Report summary",
    kind: "text",
    permission: "reports.read",
    maxPromptChars: 4000,
    system: "You summarize operational reports for management. Use only the provided figures and facts; do not forecast or invent data.",
  },
  equipment_summary: {
    id: "equipment_summary",
    label: "Equipment summary",
    kind: "text",
    permission: "equipment.read",
    maxPromptChars: 4000,
    system: "You summarize equipment service history for maintenance staff. Use only the provided facts; never invent technical specifications or measurements.",
  },
  customer_message: {
    id: "customer_message",
    label: "Customer message",
    kind: "text",
    permission: "customers.read",
    maxPromptChars: 4000,
    system: `You draft polite customer service messages for MOHD.HMS ENTERPRISE.${PROFESSIONAL_TONE} Never make commitments about scheduling or pricing.`,
  },

  // ── Structured features (server-built prompt + Zod-validated output) ──
  quotation_scope: {
    id: "quotation_scope",
    label: "Quotation scope of work",
    kind: "structured",
    permission: "quotations.manage",
    maxPromptChars: 4000,
    system: "You draft a quotation description and scope-of-work items from the given job context. Use only provided facts; never invent measurements or specifications.",
    schema: z.object({
      description: z.string().min(1).max(2000),
      scope: z.array(z.string().min(1).max(300)).min(1).max(15),
    }),
    buildPrompt: (ctx) =>
      "Draft a quotation description and a scope-of-work list for this job.\n" +
      "Respond with ONLY a JSON object: {\"description\": string, \"scope\": string[]} — 1 to 15 concise scope items." +
      aiContextBlock(ctx),
  },
  complaint_classification: {
    id: "complaint_classification",
    label: "Complaint classification",
    kind: "structured",
    permission: "complaints.update",
    maxPromptChars: 4000,
    system: "You classify facility-maintenance complaints. Use only the provided facts; choose the closest category; never invent safety-critical conclusions.",
    schema: z.object({
      category: z.string().min(1).max(80),
      priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
      summary: z.string().min(1).max(1000),
      recommendedAction: z.string().max(1000),
    }),
    buildPrompt: (ctx) =>
      "Classify this complaint for triage.\n" +
      'Respond with ONLY a JSON object: {"category": string, "priority": "LOW"|"MEDIUM"|"HIGH"|"URGENT", "summary": string, "recommendedAction": string}.' +
      aiContextBlock(ctx),
  },
};

export function getAiFeature(id: string): AiFeatureDef | null {
  return AI_FEATURES[id] ?? null;
}

export function listAiFeatures(): AiFeatureDef[] {
  return Object.values(AI_FEATURES);
}
