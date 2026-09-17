// MOHD.HMS ENTERPRISE — shared client-side formatting helpers (safe for client components)

export function money(cents: number | null | undefined): string {
  const v = (cents ?? 0) / 100;
  return v.toLocaleString("en-MY", { style: "currency", currency: "MYR", minimumFractionDigits: 2 });
}

export function toCents(amount: number | string): number {
  const n = typeof amount === "string" ? parseFloat(amount || "0") : amount;
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function fromCents(cents: number | null | undefined): string {
  return ((cents ?? 0) / 100).toFixed(2);
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
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
