"use client";

// MOHD.HMS ENTERPRISE — ONE reusable professional document header (screen +
// print). Mirrors the server-side PDF engine header (src/lib/hms/pdf/engine.ts)
// so web previews and generated PDFs share the same visual identity:
//
//   [LOGO]  COMPANY NAME                 DOC TITLE
//           address                      DOC-NUMBER
//           phone · email                Label : value
//
//   ───────────────────── green rule ──────────────────────
//
// Company identity comes from the SAME canonical settings keys used by the PDF
// branding source (company_name / company_address / company_phone /
// company_email_info) — never a second branding storage.

import Image from "next/image";
import { api } from "@/lib/hms/api-client";

export type CompanyIdentity = {
  name: string;
  address: string;
  phone: string;
  email: string;
};

export const FALLBACK_IDENTITY: CompanyIdentity = {
  name: "MOHD.HMS Enterprise",
  address: "",
  phone: "",
  email: "",
};

/**
 * Resolve the canonical company identity from /api/v1/settings with graceful
 * fallbacks (customers may not hold settings.read — they still get the
 * canonical name and simply omit the optional contact rows).
 */
export async function loadCompanyIdentity(): Promise<CompanyIdentity> {
  const id: CompanyIdentity = { ...FALLBACK_IDENTITY };
  try {
    const res = await api.get<unknown>("/api/v1/settings");
    const d = res.data;
    let map: Record<string, string> = {};
    if (Array.isArray(d)) {
      for (const row of d as { key?: string; value?: unknown }[]) {
        if (row?.key && typeof row.value === "string") map[row.key] = row.value;
      }
    } else if (d && typeof d === "object") {
      map = d as Record<string, string>;
    }
    if (map["company_name"]) id.name = map["company_name"];
    if (map["company_address"]) id.address = map["company_address"];
    if (map["company_phone"]) id.phone = map["company_phone"];
    if (map["company_email_info"]) id.email = map["company_email_info"];
  } catch {
    /* settings API unavailable — canonical fallback identity */
  }
  return id;
}

export type DocumentHeaderMeta = { label: string; value: string };

/**
 * Professional MOHD.HMS document header. Logo is vertically centered against
 * the combined identity/document block; the green rule is a dedicated element
 * BELOW all header content (never overlapping), with safe spacing on both
 * sides. Prints cleanly via the app's existing print stylesheet.
 */
export function DocumentHeader({
  company,
  title,
  number,
  meta,
}: {
  company: CompanyIdentity;
  title: string;
  number: string;
  meta: DocumentHeaderMeta[];
}) {
  const contact = [company.phone, company.email].filter(Boolean).join("  ·  ");
  return (
    <div className="doc-header text-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-x-6 gap-y-4 pb-4">
        {/* Company identity — logo vertically centered with the text block */}
        <div className="flex items-center gap-3 min-w-0">
          <Image
            src="/brand/logo-128.png"
            alt="MOHD HMS Enterprise logo"
            width={56}
            height={56}
            priority
            className="h-14 w-14 rounded-full ring-1 ring-border/40 shrink-0"
          />
          <div className="min-w-0">
            <div className="text-base font-bold text-primary leading-snug break-words">{company.name}</div>
            {/* whitespace-pre-line renders explicit line breaks exactly like the
                PDF engine's physical-line header (preview == generated PDF). */}
            {company.address ? <div className="text-xs text-muted-foreground mt-0.5 leading-snug break-words whitespace-pre-line">{company.address}</div> : null}
            {contact ? <div className="text-xs text-muted-foreground mt-0.5 leading-snug break-words">{contact}</div> : null}
          </div>
        </div>
        {/* Document identity — column-aligned Label : Value block */}
        <div className="shrink-0 sm:text-right">
          <div className="text-lg font-bold tracking-wide leading-tight">{title}</div>
          <div className="text-sm font-semibold text-primary mt-0.5">{number}</div>
          {meta.length > 0 ? (
            <div className="mt-2 grid w-fit sm:ml-auto grid-cols-[auto_auto_auto] gap-x-2 gap-y-1 text-xs">
              {meta.map((m) => (
                <div key={m.label} className="contents">
                  <span className="text-muted-foreground text-right whitespace-nowrap">{m.label}</span>
                  <span className="text-muted-foreground">:</span>
                  <span className="text-foreground tabular-nums whitespace-nowrap">{m.value}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {/* Green brand rule — its own block element BELOW the header grid */}
      <div className="h-[3px] rounded-full bg-primary mb-5" aria-hidden />
    </div>
  );
}
