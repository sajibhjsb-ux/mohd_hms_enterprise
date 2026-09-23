// MOHD.HMS ENTERPRISE — centralized localization & formatting (client- AND server-safe)
//
// SINGLE SOURCE OF TRUTH for money display. Business currency is BND
// (Brunei Darussalam). Never format currency manually in components —
// import `money()` (cents) or `formatCurrency()` (raw amount) from here.
//
// Canonical display format:  BND 1,250.00
//  - currency code prefix "BND" (unambiguous; never a bare "$")
//  - thousands grouping "," and fixed 2-decimal places
//  - deterministic en-US digit grouping, independent of device locale

import { LOCALIZATION } from "./constants";

export const CURRENCY = {
  code: LOCALIZATION.currencyCode,
  symbol: LOCALIZATION.currencySymbol,
  country: LOCALIZATION.country,
  countryCode: LOCALIZATION.countryCode,
  locale: LOCALIZATION.locale,
  timezone: LOCALIZATION.timezone,
  phoneCode: LOCALIZATION.phoneCode,
} as const;

function group2dp(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Central currency formatter — §4 of the localization standard.
 * formatCurrency(1250) → "BND 1,250.00"
 * Accepts raw amounts (number or numeric string). Pass an explicit `code`
 * only for a genuine foreign-currency transaction; default is BND.
 */
export function formatCurrency(
  amount: number | string | null | undefined,
  code: string = CURRENCY.code
): string {
  const n = typeof amount === "string" ? parseFloat(amount || "0") : (amount ?? 0);
  const safe = isFinite(n) ? n : 0;
  return `${code} ${group2dp(safe)}`;
}

/** Canonical money display from integer cents. money(125000) → "BND 1,250.00" */
export function money(cents: number | null | undefined): string {
  return formatCurrency((cents ?? 0) / 100);
}

/**
 * Convert a user-entered amount to integer cents using ROUND-HALF-UP at 2 dp
 * evaluated on the decimal string — immune to binary floating-point drift
 * (e.g. 10.55 → 1055, 100.005 → 10001, 999.999 → 100000).
 */
export function toCents(amount: number | string): number {
  const raw = (typeof amount === "number" ? amount.toFixed(12) : String(amount ?? ""))
    .trim()
    .replace(/,/g, "");
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw === "" ? "0" : raw);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const intPart = m[2] || "0";
  const frac = (m[3] ?? "").padEnd(3, "0");
  const cents = Number(intPart) * 100 + Number(frac.slice(0, 2));
  return sign * (cents + (Number(frac[2]) >= 5 ? 1 : 0));
}

export function fromCents(cents: number | null | undefined): string {
  return ((cents ?? 0) / 100).toFixed(2);
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: CURRENCY.timezone,
  });
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: CURRENCY.timezone,
  });
}

export function fmtTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: CURRENCY.timezone,
  });
}

export function toDateInput(d: string | Date | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function initials(name: string): string {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

/**
 * Display label for a customer record. Company name is OPTIONAL for customers
 * (individuals / homeowners / tenants) — fall back to the contact person so
 * no customer ever shows as blank. Use wherever customer.companyName was
 * previously rendered as the primary label.
 */
export function customerLabel(
  c: { companyName?: string | null; contactPerson?: string | null; name?: string | null } | null | undefined
): string {
  if (!c) return "—";
  const company = (c.companyName ?? "").trim();
  if (company) return company;
  const person = (c.contactPerson ?? c.name ?? "").trim();
  return person || "—";
}
