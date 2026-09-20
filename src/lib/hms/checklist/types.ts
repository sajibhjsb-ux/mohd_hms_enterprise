// MOHD.HMS ENTERPRISE — Centralized checklist engine shared types.
// Client-safe (type-only module): imported by both server engine and frontend.
// ONE item shape across the template library, AI drafts and WO execution rows
// (AI checklist spec §9: "Do not create every field unless the actual
// application needs it" — the execution surface supports exactly these fields).

export type ChecklistSourceType = "COMPLAINT" | "WORK_ORDER" | "PM" | "IRMS";
export type ChecklistOrigin = "AI" | "TEMPLATE" | "MANUAL" | "HYBRID";
export type ChecklistStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
export type ChecklistResponseType = "CHECKBOX" | "PASSFAIL" | "YESNO" | "NUMERIC" | "TEXT";
export type ChecklistTaskPriority = "ROUTINE" | "IMPORTANT" | "SAFETY" | "CRITICAL";

/** The ONE structured checklist item (spec §9/§42). */
export type ChecklistItemSpec = {
  label: string;
  description?: string;
  required: boolean;
  responseType: ChecklistResponseType;
  priority?: ChecklistTaskPriority;
  safetyCritical?: boolean;
  /** Observation guidance only — the engine never persists AI-invented thresholds (§6/§13). */
  expectedResult?: string;
  /** Observation unit for NUMERIC readings (V, A, °C, bar…). */
  unit?: string;
  requiresPhoto?: boolean;
  failRequiresFinding?: boolean;
  /** Per-item provenance (spec §64) — AI items inside a human-edited draft stay labelled. */
  origin?: ChecklistOrigin;
};

export function parseChecklistItems(json: string | null | undefined): ChecklistItemSpec[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((it): it is ChecklistItemSpec => !!it && typeof it === "object" && typeof (it as ChecklistItemSpec).label === "string");
  } catch {
    return [];
  }
}
