// MOHD.HMS ENTERPRISE — Letters: server-side reference numbering (§17).
//
//   Default pattern:  HMS/{DEPT}/{TYPE}/{YYYY}/{SEQ}   →  HMS/HR/LOU/2026/0001
//
// The pattern is company-configurable via the Setting key
// `letter_number_pattern` (ADMIN → Settings). {SEQ} comes from the central
// Counter table (same transactional upsert-increment used by every other
// document series) so numbers are server-side, gap-tolerant and NEVER
// duplicated; the Letter.letterNumber unique constraint is the final guard.

import "server-only";
import { db } from "@/lib/db";

export const LETTER_NUMBER_PATTERN_DEFAULT = "HMS/{DEPT}/{TYPE}/{YYYY}/{SEQ}";

export async function getLetterNumberPattern(): Promise<string> {
  try {
    const row = await db.setting.findUnique({ where: { key: "letter_number_pattern" } });
    const v = row?.value?.trim();
    // A pattern must contain the sequence slot, otherwise numbers collide.
    return v && v.includes("{SEQ}") ? v : LETTER_NUMBER_PATTERN_DEFAULT;
  } catch {
    return LETTER_NUMBER_PATTERN_DEFAULT;
  }
}

/** Official letter date is the SERVER date in the business timezone (§18). */
export function serverLetterDate(): Date {
  return new Date();
}

/** Brunei-calendar year for the {YYYY} slot (Asia/Brunei, §18). */
export function bruneiYear(d: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Brunei", year: "numeric" }).format(d));
}

/**
 * Allocate the next reference number for a department+type+year series.
 * Counter upsert-increment is atomic per key; the unique column guarantees
 * global uniqueness even under a race.
 */
export async function nextLetterNumber(letterType: string, department: string, forYear: number): Promise<string> {
  const pattern = await getLetterNumberPattern();
  const counterKey = `LETTER-${department}-${letterType}-${forYear}`;
  const row = await db.counter.upsert({
    where: { key: counterKey },
    update: { value: { increment: 1 } },
    create: { key: counterKey, value: 1 },
  });
  const seq = String(row.value).padStart(4, "0");
  return pattern
    .replace(/\{DEPT\}/g, (department || "HR").toUpperCase())
    .replace(/\{TYPE\}/g, letterType.toUpperCase())
    .replace(/\{YYYY\}/g, String(forYear))
    .replace(/\{MM\}/g, String(bruneiMonth()).padStart(2, "0"))
    .replace(/\{SEQ\}/g, seq);
}

function bruneiMonth(d: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Brunei", month: "numeric" }).format(d));
}
