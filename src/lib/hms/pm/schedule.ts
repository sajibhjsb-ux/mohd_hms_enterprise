// MOHD.HMS ENTERPRISE — Preventive Maintenance scheduling engine (PM spec §5–§11,
// §30–§31, §56). Pure functions only (no db) so both API routes and the workflow
// engine can reuse the exact same calculations — one authoritative implementation.

import { addDays, addWeeks, addMonths, addYears, startOfMonth, getDay, getDaysInMonth, isAfter } from "date-fns";
import { PM_METER_PLAN_TYPES } from "@/lib/hms/constants";

/** §7 — display labels for every supported calendar frequency. */
export const PM_FREQUENCY_LABELS: Record<string, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  BIWEEKLY: "Biweekly",
  MONTHLY: "Monthly",
  EVERY_2_MONTHS: "Every 2 months",
  QUARTERLY: "Quarterly",
  SEMI_ANNUAL: "Half-yearly",
  ANNUAL: "Yearly",
  CUSTOM: "Custom interval",
};

export const PM_PLAN_TYPE_LABELS: Record<string, string> = {
  CALENDAR: "Calendar-based",
  METER: "Meter-based",
  USAGE: "Usage-based",
  RUNTIME: "Runtime-based",
  CONDITION: "Condition-based",
  SEASONAL: "Seasonal",
  INSPECTION: "Inspection-based",
};

/** Base calendar cadence of each named frequency, expressed in date-fns units. */
const FREQUENCY_BASE: Record<string, { amount: number; unit: "days" | "weeks" | "months" | "years" }> = {
  DAILY: { amount: 1, unit: "days" },
  WEEKLY: { amount: 1, unit: "weeks" },
  BIWEEKLY: { amount: 2, unit: "weeks" },
  MONTHLY: { amount: 1, unit: "months" },
  EVERY_2_MONTHS: { amount: 2, unit: "months" },
  QUARTERLY: { amount: 3, unit: "months" },
  SEMI_ANNUAL: { amount: 6, unit: "months" },
  ANNUAL: { amount: 1, unit: "years" },
};

export type ChecklistTemplateItem = { label: string; required: boolean; responseType: string };

/**
 * Normalize a stored checklist template into rich items. Accepts both the legacy
 * format (plain label strings) and the rich format ({label, required, responseType})
 * so historical plans keep working (PM §54 — historical records never mutate).
 */
export function parseChecklistTemplate(json: string | null | undefined): ChecklistTemplateItem[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const items: ChecklistTemplateItem[] = [];
    for (const raw of parsed) {
      if (typeof raw === "string") {
        const label = raw.trim();
        if (label) items.push({ label, required: false, responseType: "CHECKBOX" });
      } else if (raw && typeof raw === "object" && "label" in raw) {
        const label = String((raw as { label: unknown }).label ?? "").trim();
        if (!label) continue;
        const responseType = String((raw as { responseType?: unknown }).responseType ?? "CHECKBOX");
        items.push({
          label,
          required: Boolean((raw as { required?: unknown }).required),
          responseType: ["CHECKBOX", "PASSFAIL", "YESNO", "NUMERIC", "TEXT"].includes(responseType) ? responseType : "CHECKBOX",
        });
      }
    }
    return items;
  } catch {
    return [];
  }
}

/** Serialize rich items back to the stored JSON template format. */
export function serializeChecklistTemplate(items: ChecklistTemplateItem[]): string {
  return JSON.stringify(items.map((i) => ({ label: i.label, required: i.required, responseType: i.responseType })));
}

export function isMeterPlanType(planType: string): boolean {
  return PM_METER_PLAN_TYPES.includes(planType as (typeof PM_METER_PLAN_TYPES)[number]);
}

/** Nth (FIRST/SECOND/THIRD/FOURTH/LAST) `weekday` of the month of `monthStart`. */
function nthWeekdayOfMonth(monthStart: Date, occurrence: string, weekday: number): Date | null {
  const daysInMonth = getDaysInMonth(monthStart);
  const matching: number[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    if (getDay(new Date(monthStart.getFullYear(), monthStart.getMonth(), d)) === weekday) matching.push(d);
  }
  if (matching.length === 0) return null;
  let day: number | null = null;
  if (occurrence === "LAST") day = matching[matching.length - 1];
  else {
    const index = { FIRST: 0, SECOND: 1, THIRD: 2, FOURTH: 3 }[occurrence] ?? -1;
    if (index < 0) return null;
    day = matching[index] ?? null;
  }
  return day === null ? null : new Date(monthStart.getFullYear(), monthStart.getMonth(), day, 12, 0, 0, 0);
}

export type ScheduleEnginePlan = {
  planType: string;
  frequency: string;
  customIntervalDays?: number | null;
  intervalUnits?: number | null;
  intervalUnit?: string | null;
  monthlyOccurrence?: string | null;
  monthlyWeekday?: number | null;
  endDate?: Date | null;
  // meter-based extras
  meterInterval?: number | null;
  nextDueMeter?: number | null;
};

/**
 * §7/§8/§31 — compute the next calendar due date strictly after `fromDate`.
 * Returns null when the plan has ended (endDate passed) — the cycle stops.
 * Cadence advances from the occurrence's due date (plan basis) so the schedule
 * stays fixed; if completion drifted past the computed next date the caller
 * rolls forward from completion (§31).
 */
export function computeNextCalendarDue(plan: ScheduleEnginePlan, fromDate: Date): Date | null {
  if (plan.endDate && isAfter(fromDate, plan.endDate)) return null;

  // §8 advanced recurrence — Nth/last weekday of every Nth month.
  if (plan.monthlyOccurrence && plan.monthlyWeekday !== null && plan.monthlyWeekday !== undefined) {
    const step = plan.intervalUnits && plan.intervalUnits > 0 ? plan.intervalUnits : 1;
    let month = startOfMonth(fromDate);
    for (let guard = 0; guard < 24; guard++) {
      month = addMonths(month, step);
      const candidate = nthWeekdayOfMonth(month, plan.monthlyOccurrence, plan.monthlyWeekday);
      if (candidate && isAfter(candidate, fromDate)) {
        if (plan.endDate && isAfter(candidate, plan.endDate)) return null;
        return candidate;
      }
    }
    return null;
  }

  // §7 — every N units (intervalUnits/intervalUnit) or named frequency.
  const base = FREQUENCY_BASE[plan.frequency];
  if (base) {
    const amount = (plan.intervalUnits && plan.intervalUnits > 0 ? plan.intervalUnits : 1) * base.amount;
    const next =
      base.unit === "days" ? addDays(fromDate, amount)
      : base.unit === "weeks" ? addWeeks(fromDate, amount)
      : base.unit === "months" ? addMonths(fromDate, amount)
      : addYears(fromDate, amount);
    if (plan.endDate && isAfter(next, plan.endDate)) return null;
    return next;
  }

  // CUSTOM interval — every N days.
  if (plan.frequency === "CUSTOM") {
    const days = plan.customIntervalDays && plan.customIntervalDays > 0 ? plan.customIntervalDays : null;
    if (!days) return null;
    const next = addDays(fromDate, days);
    if (plan.endDate && isAfter(next, plan.endDate)) return null;
    return next;
  }

  return null;
}

/**
 * §9 — meter engine: the plan becomes due when the meter's current reading has
 * reached nextDueMeter. The next due meter = crossing point + interval.
 */
export function computeNextDueMeter(plan: ScheduleEnginePlan): number | null {
  if (!plan.meterInterval || plan.meterInterval <= 0) return null;
  const base = plan.nextDueMeter ?? plan.meterInterval;
  return base + plan.meterInterval;
}

/** §31 — backend-authoritative next-due dispatcher (date for calendar plans, meter threshold for meter plans). */
export function computeNextDue(plan: ScheduleEnginePlan, fromDate: Date): { nextDueDate?: Date; nextDueMeter?: number } {
  if (isMeterPlanType(plan.planType)) {
    const m = computeNextDueMeter(plan);
    return m === null ? {} : { nextDueMeter: m };
  }
  const d = computeNextCalendarDue(plan, fromDate);
  return d ? { nextDueDate: d } : {};
}

/** §32 — days overdue (integer, ≥ 0) for display; does NOT move any due date. */
export function daysOverdue(dueDate: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / 86400000));
}

export type MetricTask = {
  status: string;
  dueDate: Date;
  completedAt?: Date | null;
};

export type PmMetrics = {
  windowDays: number;
  graceDays: number;
  dueOccurrences: number;
  completedOnTime: number;
  compliancePct: number;
  completed: number;
  completionPct: number;
  excluded: number; // SKIPPED / CANCELLED — documented exclusion from §56
};

/**
 * §56 — the ONE centralized compliance calculation (same formula on every screen):
 *   Compliance % = completed-on-time ÷ due-occurrences (within window)
 *   - due occurrence = task with dueDate in the window and status in
 *     COMPLETED | OVERDUE | FAILED | IN_PROGRESS | SCHEDULED (it needed doing)
 *   - completed on time = completedAt ≤ dueDate + graceDays
 *   - SKIPPED / CANCELLED are excluded from BOTH sides (never counted as
 *     completed, never punished — PM §74).
 *   Completion % = completed ÷ due-occurrences (same denominator).
 */
export function computePmMetrics(tasks: MetricTask[], opts?: { windowDays?: number; graceDays?: number; now?: Date }): PmMetrics {
  const windowDays = opts?.windowDays ?? 90;
  const graceDays = opts?.graceDays ?? 0;
  const now = opts?.now ?? new Date();
  const windowStart = addDays(now, -windowDays);

  let dueOccurrences = 0;
  let completedOnTime = 0;
  let completed = 0;
  let excluded = 0;

  for (const t of tasks) {
    if (t.dueDate < windowStart || t.dueDate > now) continue;
    if (t.status === "SKIPPED" || t.status === "CANCELLED") {
      excluded += 1;
      continue;
    }
    if (!["COMPLETED", "OVERDUE", "FAILED", "IN_PROGRESS", "SCHEDULED"].includes(t.status)) continue;
    dueOccurrences += 1;
    if (t.status === "COMPLETED") {
      completed += 1;
      const deadline = addDays(t.dueDate, graceDays);
      if (t.completedAt && t.completedAt <= deadline) completedOnTime += 1;
    }
  }

  const compliancePct = dueOccurrences > 0 ? Math.round((completedOnTime / dueOccurrences) * 100) : 100;
  const completionPct = dueOccurrences > 0 ? Math.round((completed / dueOccurrences) * 100) : 100;
  return { windowDays, graceDays, dueOccurrences, completedOnTime, compliancePct, completed, completionPct, excluded };
}

/** PM priority → canonical work-order priority (WO uses URGENT instead of CRITICAL). */
export function mapPriorityToWo(priority: string): string {
  return priority === "CRITICAL" ? "URGENT" : priority;
}

/** §34 — default plan priority derived from equipment criticality. */
export function priorityFromCriticality(criticality: string): string {
  return ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(criticality) ? criticality : "MEDIUM";
}
