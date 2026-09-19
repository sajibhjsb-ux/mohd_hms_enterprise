// MOHD.HMS ENTERPRISE — PDF branding source (§17).
// Uses the SAME canonical company settings (Setting keys `company_*`) and the
// SAME logo asset (public/brand) as the login screen, header and documents —
// never a second branding storage.

import "server-only";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";

export type Branding = {
  company: string;
  address: string;
  phone: string;
  email: string;
  country: string;
  contactLines: string[];
  logoBytes: Buffer | null;
};

const FALLBACK_COMPANY = "MOHD.HMS Enterprise";

let logoCache: Buffer | null | undefined;

function loadLogo(): Buffer | null {
  if (logoCache !== undefined) return logoCache;
  try {
    // public/brand/logo-256.png is the canonical logo used across the app/PWA.
    logoCache = fs.readFileSync(path.join(process.cwd(), "public", "brand", "logo-256.png"));
  } catch {
    try {
      logoCache = fs.readFileSync(path.join(process.cwd(), "public", "logo.svg"));
    } catch {
      logoCache = null;
    }
  }
  return logoCache;
}

/** Resolve company branding from the settings table with graceful fallbacks. */
export async function getBranding(): Promise<Branding> {
  let company = FALLBACK_COMPANY;
  let address = "";
  let phone = "";
  let email = "";
  let country = "Brunei Darussalam";
  try {
    const rows = await db.setting.findMany({
      where: { key: { in: ["company_name", "company_address", "company_phone", "company_email_info", "company_country"] } },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (map["company_name"]) company = map["company_name"];
    if (map["company_address"]) address = map["company_address"];
    if (map["company_phone"]) phone = map["company_phone"];
    if (map["company_email_info"]) email = map["company_email_info"];
    if (map["company_country"]) country = map["company_country"];
  } catch {
    // Settings unavailable — fall back to the canonical company identity.
  }
  // The address may contain explicit line breaks (multi-line company address —
  // fully supported). Split into physical lines so every saved line renders as
  // its own header row; the engine measures the result and moves the brand rule
  // / body down automatically. The engine additionally flattens defensively,
  // but contactLines being one-line-per-entry keeps the header math exact.
  const addressLines = address.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const contactLines = [...addressLines, [phone, email].filter(Boolean).join("  ·  ")].filter(Boolean);
  return { company, address, phone, email, country, contactLines, logoBytes: loadLogo() };
}
