import "server-only";

// MOHD.HMS ENTERPRISE — Payroll engine configuration (spec §11/§12/§25/§47).
//
// Company-level calculation policy lives here in ONE place so the engine stays
// transparent and auditable. Statutory/legal rates are NOT here — they are
// configurable, versioned StatutoryRule rows in PostgreSQL (spec §18/§19).

export const PAYROLL_CONFIG = {
  /** Engine version stamped into each run's config snapshot (§46). */
  engineVersion: 1,
  /** Non-working days (Brunei: Friday & Sunday) used for working-day counts.
   *  Matched against long weekday names from toLocaleDateString("en-US"). */
  weekendDays: ["Friday", "Sunday"] as string[],
  /** Standard paid hours per working day (overtime rate derivation). */
  standardHoursPerDay: 8,
  /** Default overtime multiplier when a request does not specify one. */
  defaultOtMultiplier: 1.5,
  /** Variance review thresholds (§44). */
  variance: {
    /** |net change| beyond this (basis points) flags a review exception. */
    netChangeBps: 3000, // 30%
    /** Deductions above this fraction of gross flag a review exception. */
    deductionRatioBps: 6000, // 60%
    /** Overtime above this fraction of gross flags a review exception. */
    overtimeRatioBps: 3000, // 30%
  },
} as const;

export type PayrollLineKind = "EARNING" | "DEDUCTION" | "EMPLOYER" | "INFO";

/** One traceable calculation line (spec §48 — no unexplained totals). */
export type PayrollLine = {
  code: string;
  label: string;
  kind: PayrollLineKind;
  category: string;
  amountCents: number;
  basis?: string;
  detail?: string;
};

/** Engine config snapshot stored on the run (§46 — reproducible history). */
export function engineConfigSnapshot(): Record<string, unknown> {
  return {
    engineVersion: PAYROLL_CONFIG.engineVersion,
    weekendDays: PAYROLL_CONFIG.weekendDays,
    standardHoursPerDay: PAYROLL_CONFIG.standardHoursPerDay,
    currency: "BND",
    moneyStorage: "INT_CENTS",
  };
}

/** "2026-09" period key from a period start date. */
export function periodKeyOf(periodStart: Date): string {
  const y = periodStart.getUTCFullYear();
  const m = `${periodStart.getUTCMonth() + 1}`.padStart(2, "0");
  return `${y}-${m}`;
}

/** Month index (0-11) from a period key. */
export function monthOfPeriodKey(periodKey: string): number {
  const m = Number.parseInt(periodKey.split("-")[1] ?? "1", 10);
  return Number.isFinite(m) ? m - 1 : 0;
}
