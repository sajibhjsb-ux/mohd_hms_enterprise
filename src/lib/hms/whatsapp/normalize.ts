// MOHD.HMS ENTERPRISE — WhatsApp phone normalization (§14).
// MOHD.HMS operates in Brunei Darussalam (+673). One canonical representation
// everywhere: E.164 ("+6737123456" / "+60377881200"). WhatsApp chat IDs are
// generated server-side from the canonical number ("<digits>@c.us") and never
// leak gateway internals to the frontend. @lid privacy ids are NEVER guessed
// into phone numbers (§42) — inbound senders are resolved only via OpenWA's
// senderPhone/contact fields.

import { LOCALIZATION } from "@/lib/hms/constants";

const CC = LOCALIZATION.phoneCode.replace("+", ""); // "673"

export type NormalizedPhone = { ok: true; e164: string; chatId: string } | { ok: false; reason: string };

/**
 * Normalize a raw phone string into canonical E.164.
 *
 * Brunei locals (default country): "+673 7123456" · "6737123456" · "7123456" ·
 * "07123456" (trunk 0 dropped) → "+6737123456".
 *
 * Explicit international numbers ("+60 3-7788 1200") are accepted as-is when
 * they form a plausible E.164 — the company serves regional customers too.
 * Malformed or truncated input is rejected, never guessed.
 */
export function normalizePhone(raw: string | null | undefined): NormalizedPhone {
  if (!raw) return { ok: false, reason: "Phone number is empty" };
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "Phone number contains no digits" };

  let e164: string;
  if (plus) {
    // Explicit E.164 as given (+<CC><national>). Validate plausibility only.
    e164 = `+${digits}`;
  } else if (digits.startsWith(CC)) {
    // "<CC><national>" without the plus — treat as country-coded.
    const national = digits.slice(CC.length).replace(/^0+/, "");
    if (national.length < 6 || national.length > 10) {
      return { ok: false, reason: `Phone number has an unexpected length (${national.length} digits)` };
    }
    e164 = `+${CC}${national}`;
  } else {
    // Local format (no country code): drop a leading trunk 0 if present.
    const national = digits.replace(/^0+/, "");
    if (national.length < 6 || national.length > 10) {
      return { ok: false, reason: `Phone number has an unexpected length (${national.length} digits)` };
    }
    if (national.startsWith("0") || national.startsWith("1")) {
      return { ok: false, reason: "Phone number does not look like a local Brunei number" };
    }
    e164 = `+${CC}${national}`;
  }

  const totalDigits = e164.replace(/\D/g, "").length;
  if (totalDigits < 8 || totalDigits > 15) {
    return { ok: false, reason: `Phone number is not a valid E.164 (${totalDigits} digits)` };
  }
  return { ok: true, e164, chatId: `${e164.slice(1)}@c.us` };
}

/** Canonical chat id from an already-normalized E.164 (+673…). */
export function chatIdFromE164(e164: string): string {
  return `${e164.replace(/\D/g, "")}@c.us`;
}

/**
 * Extract a phone number from an OpenWA chat/sender id — only when the id
 * IS a phone-based id ("<digits>@c.us"). @lid / group ids return null; the
 * caller must then use the payload's senderPhone/contact.number (§42).
 */
export function phoneFromWaId(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = /^(\d+)@c\.us$/i.exec(id.trim());
  if (!m) return null;
  const digits = m[1];
  // Long ids carry the country code embedded (e.g. 6737123456).
  if (digits.length > 6) return `+${digits}`;
  // Short bare numbers are treated as Brunei locals.
  return `+${CC}${digits}`;
}

/** True when the id is a WhatsApp privacy id (@lid) — identity unknown. */
export function isLidId(id: string | null | undefined): boolean {
  return !!id && /@lid$/i.test(id.trim());
}
