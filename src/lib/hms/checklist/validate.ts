// MOHD.HMS ENTERPRISE — Deterministic checklist validation (AI checklist spec §41).
// Every AI output passes through here BEFORE anything is persisted. The AI never
// writes production data directly: structure, vocabularies, duplicates, size and
// threshold-safety are all checked deterministically. Invalid output is rejected
// with the spec's exact message — "AI-generated checklist requires correction."

import "server-only";
import type { ChecklistItemSpec, ChecklistResponseType, ChecklistTaskPriority } from "./types";

/** AI vocabulary → execution-surface response types (spec §10, mapped deterministically). */
const RESPONSE_TYPE_MAP: Record<string, ChecklistResponseType> = {
  CHECKBOX: "CHECKBOX",
  YES_NO: "YESNO", YESNO: "YESNO",
  PASS_FAIL: "PASSFAIL", PASSFAIL: "PASSFAIL",
  TEXT: "TEXT", LONG_TEXT: "TEXT", DROPDOWN: "TEXT", MULTI_SELECT: "TEXT", DATE: "TEXT", TIME: "TEXT",
  NUMBER: "NUMERIC", NUMERIC: "NUMERIC", DECIMAL: "NUMERIC",
  TEMPERATURE: "NUMERIC", PRESSURE: "NUMERIC", VOLTAGE: "NUMERIC", CURRENT: "NUMERIC",
  RESISTANCE: "NUMERIC", PERCENTAGE: "NUMERIC", METER_READING: "NUMERIC",
  PHOTO: "CHECKBOX", VIDEO: "CHECKBOX", SIGNATURE: "CHECKBOX",
};

const PRIORITY_MAP: Record<string, ChecklistTaskPriority> = {
  ROUTINE: "ROUTINE", IMPORTANT: "IMPORTANT", SAFETY: "SAFETY", CRITICAL: "CRITICAL",
  LOW: "ROUTINE", MEDIUM: "ROUTINE", HIGH: "IMPORTANT",
};

/**
 * Observation units allowed on items (spec §13 — structured readings). This is a
 * LABEL of what to observe, never a pass/fail threshold: the validator strips any
 * AI-supplied minimum/maximum value outright.
 */
const ALLOWED_UNITS = new Set([
  "V", "A", "°C", "bar", "psi", "Ω", "ohm", "%", "h", "hr", "hrs",
  "L", "L/min", "kg", "kPa", "rpm", "mm", "cm", "m", "kW", "Hz", "lux", "cfm",
]);

const MAX_TASKS_HARD = 80;
const MIN_TASKS = 3;

export type AiChecklistRaw = { checklist_title?: unknown; tasks?: unknown };

export type ValidationResult =
  | { ok: true; title: string; items: ChecklistItemSpec[]; dropped: string[] }
  | { ok: false; reason: string };

function asString(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function asBool(v: unknown): boolean {
  return v === true || v === "true";
}

/** Character-bigram Jaccard similarity — catches near-duplicate task titles (§60). */
function bigramJaccard(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a), B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Validate + normalize a raw AI checklist object into safe ChecklistItemSpecs.
 * Never throws. Honours the spec's deterministic rules:
 *  - valid structure / allowed types / no missing core fields (§41)
 *  - duplicate + near-duplicate removal (§60) — dropped labels are reported
 *  - maximum size from configuration (§59)
 *  - AI-invented thresholds (minimum_value/maximum_value…) are stripped, never saved (§6/§13)
 */
export function validateAiChecklist(raw: unknown, opts: { maxTasks: number }): ValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "AI-generated checklist requires correction." };
  }
  const obj = raw as AiChecklistRaw;
  const title = asString(obj.checklist_title, 200) || "AI Generated Checklist";

  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    return { ok: false, reason: "AI-generated checklist requires correction." };
  }

  const maxTasks = Math.max(MIN_TASKS, Math.min(MAX_TASKS_HARD, Math.floor(opts.maxTasks) || 50));
  const dropped: string[] = [];
  const items: ChecklistItemSpec[] = [];
  const seen = new Set<string>();

  for (const task of obj.tasks) {
    if (items.length >= maxTasks) { dropped.push("(max task limit reached)"); break; }
    if (!task || typeof task !== "object" || Array.isArray(task)) continue;
    const t = task as Record<string, unknown>;
    const label = asString(t.title ?? t.label ?? t.task, 300);
    if (label.length < 3) { dropped.push(label || "(untitled task)"); continue; }

    // Duplicate / near-duplicate detection on the normalized title (§60).
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    let isDup = seen.has(key);
    if (!isDup) {
      for (const existing of items) {
        if (bigramJaccard(existing.label, label) >= 0.82) { isDup = true; break; }
      }
    }
    if (isDup) { dropped.push(label); continue; }
    seen.add(key);

    const rawType = asString(t.input_type ?? t.responseType ?? "CHECKBOX", 40).toUpperCase().replace(/[\s-]+/g, "_");
    const responseType = RESPONSE_TYPE_MAP[rawType] ?? "TEXT";

    // Safety-first (§6/§13): strip ANY threshold-ish field the model may have added.
    for (const banned of ["minimum_value", "maximum_value", "min", "max", "min_value", "max_value", "threshold", "expected_range", "tolerance"]) {
      delete t[banned];
    }
    const rawUnit = asString(t.unit, 12);
    const unit = responseType === "NUMERIC" && ALLOWED_UNITS.has(rawUnit) ? rawUnit : "";

    const rawPriority = asString(t.priority, 20).toUpperCase();
    const priority = PRIORITY_MAP[rawPriority] ?? "ROUTINE";
    const description = asString(t.description, 1000);
    // Safety-critical flags come from the model's SUGGESTION only (§14) — they are
    // advisory labels for the human reviewer, never auto-legal requirements.
    const safetyCritical = asBool(t.safety_critical) || priority === "SAFETY" || priority === "CRITICAL";

    items.push({
      label,
      ...(description ? { description } : {}),
      required: typeof t.required === "boolean" ? t.required : true,
      responseType,
      priority,
      ...(safetyCritical ? { safetyCritical: true } : {}),
      ...(unit ? { unit } : {}),
      requiresPhoto: asBool(t.requires_photo ?? t.requiresPhoto),
      failRequiresFinding: responseType === "PASSFAIL" || responseType === "YESNO",
      origin: "AI",
    });
  }

  if (items.length < MIN_TASKS) {
    return { ok: false, reason: "AI-generated checklist requires correction." };
  }
  return { ok: true, title, items, dropped };
}

/** Validate a single manually-entered item (review page Add Task — spec §25). */
export function validateManualItem(input: unknown): ChecklistItemSpec | null {
  if (!input || typeof input !== "object") return null;
  const t = input as Record<string, unknown>;
  const label = asString(t.label, 300);
  if (label.length < 2) return null;
  const rawType = asString(t.responseType ?? "CHECKBOX", 20).toUpperCase();
  const responseType = (["CHECKBOX", "PASSFAIL", "YESNO", "NUMERIC", "TEXT"] as const).includes(rawType as ChecklistResponseType)
    ? (rawType as ChecklistResponseType)
    : "CHECKBOX";
  const rawPriority = asString(t.priority, 20).toUpperCase();
  const priority = (["ROUTINE", "IMPORTANT", "SAFETY", "CRITICAL"] as const).includes(rawPriority as ChecklistTaskPriority)
    ? (rawPriority as ChecklistTaskPriority)
    : "ROUTINE";
  return {
    label,
    ...(asString(t.description, 1000) ? { description: asString(t.description, 1000) } : {}),
    required: t.required === true,
    responseType,
    priority,
    ...(asBool(t.safetyCritical) ? { safetyCritical: true } : {}),
    ...(asString(t.expectedResult, 300) ? { expectedResult: asString(t.expectedResult, 300) } : {}),
    ...(asString(t.unit, 12) ? { unit: asString(t.unit, 12) } : {}),
    requiresPhoto: asBool(t.requiresPhoto),
    failRequiresFinding: responseType === "PASSFAIL" || responseType === "YESNO",
    origin: "MANUAL",
  };
}
