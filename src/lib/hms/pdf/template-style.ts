// MOHD.HMS ENTERPRISE — Document template style schema (Settings → Templates).
//
// Shared by the PDF engine (server), TemplateService (server) and the template
// editor UI (client) — deliberately NO "server-only" import here.
//
// Everything an administrator may customize about a document template's LOOK
// lives in this one controlled schema (spec §15-§20). Only pdf-lib standard
// fonts are exposed (§17 — arbitrary fonts would break PDF generation), sizes
// and margins are bounded (§19 — no overlapping layouts), and colors are
// validated for print readability (§16 — no unreadable combinations).

export const TEMPLATE_FONTS = ["Helvetica", "Times-Roman", "Courier"] as const;
export type TemplateFont = (typeof TEMPLATE_FONTS)[number];

export type TemplateStyle = {
  /** Brand accent — headings marker, header rule, table header band, totals accent, QR caption. */
  primaryColor: string; // hex "#RRGGBB"
  /** Body text color. */
  textColor: string;
  /** Table row separators / photo-card borders. */
  borderColor: string;
  /** Only pdf-lib standard (WinAnsi-safe) families — §17. */
  fontFamily: TemplateFont;
  /** Body text size in pt (scaled elements: paragraphs, tables, grids, totals, headings). */
  baseFontSize: number;
  /** Line-spacing multiplier for flowing text/rows (§17 line spacing). */
  lineHeight: number;
  orientation: "portrait" | "landscape";
  /** Page margins in pt (§19) — bounded so header/footer can never collide with content. */
  margins: { top: number; bottom: number; left: number; right: number };
  /** Header visibility toggles (§20) — the dynamic multi-line address header stays measured (no fixed heights). */
  header: {
    logo: boolean;
    company: boolean;
    address: boolean;
    contact: boolean;
    docNumber: boolean;
    date: boolean;
    meta: boolean;
  };
  /** Footer configuration (§20). */
  footer: {
    pageNumber: boolean;
    generatedDate: boolean;
    contact: boolean;
    customText: string; // optional left footer text (overrides the company label when set)
  };
};

/** Hard bounds — the editor UI and the validator share these exact numbers. */
export const STYLE_BOUNDS = {
  fontSize: { min: 8, max: 11, default: 9 },
  lineHeight: { min: 1, max: 1.5, default: 1 },
  margin: { min: 24, max: 72, default: 46 },
} as const;

/** Canonical brand defaults — byte-for-byte the palette the engine has always
 *  used, so a fresh template renders exactly like the built-in layout (§15). */
export const DEFAULT_TEMPLATE_STYLE: TemplateStyle = {
  primaryColor: "#156B3C",
  textColor: "#21262B",
  borderColor: "#D6DBE0",
  fontFamily: "Helvetica",
  baseFontSize: STYLE_BOUNDS.fontSize.default,
  lineHeight: STYLE_BOUNDS.lineHeight.default,
  orientation: "portrait",
  margins: {
    top: STYLE_BOUNDS.margin.default,
    bottom: STYLE_BOUNDS.margin.default,
    left: STYLE_BOUNDS.margin.default,
    right: STYLE_BOUNDS.margin.default,
  },
  header: { logo: true, company: true, address: true, contact: true, docNumber: true, date: true, meta: true },
  footer: { pageNumber: true, generatedDate: true, contact: true, customText: "" },
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Relative-luminance contrast ratio (WCAG) between a color and white — used
 *  to keep administrators inside readable combinations (§16). */
export function contrastAgainstWhite(hex: string): number {
  if (!HEX_RE.test(hex)) return 0;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const r = lin(parseInt(hex.slice(1, 3), 16) / 255);
  const g = lin(parseInt(hex.slice(3, 5), 16) / 255);
  const b = lin(parseInt(hex.slice(5, 7), 16) / 255);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (1.0 + 0.05) / (l + 0.05);
}

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
};

const boolOr = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/**
 * Normalize + validate ANY untrusted style input into a safe TemplateStyle.
 * Invalid values silently fall back to defaults (never throw) — publish-time
 * validation reports readability problems separately (§14/§16).
 */
export function sanitizeStyle(input: unknown): TemplateStyle {
  const raw = (input ?? {}) as Partial<TemplateStyle>;
  const d = DEFAULT_TEMPLATE_STYLE;
  const marginsIn = (raw.margins ?? {}) as Partial<TemplateStyle["margins"]>;
  const headerIn = (raw.header ?? {}) as Partial<TemplateStyle["header"]>;
  const footerIn = (raw.footer ?? {}) as Partial<TemplateStyle["footer"]>;
  return {
    primaryColor: isHexColor(raw.primaryColor) ? raw.primaryColor : d.primaryColor,
    textColor: isHexColor(raw.textColor) ? raw.textColor : d.textColor,
    borderColor: isHexColor(raw.borderColor) ? raw.borderColor : d.borderColor,
    fontFamily: TEMPLATE_FONTS.includes(raw.fontFamily as TemplateFont) ? (raw.fontFamily as TemplateFont) : d.fontFamily,
    baseFontSize: clampNum(raw.baseFontSize, STYLE_BOUNDS.fontSize.min, STYLE_BOUNDS.fontSize.max, STYLE_BOUNDS.fontSize.default),
    lineHeight: clampNum(raw.lineHeight, STYLE_BOUNDS.lineHeight.min, STYLE_BOUNDS.lineHeight.max, STYLE_BOUNDS.lineHeight.default),
    orientation: raw.orientation === "landscape" ? "landscape" : "portrait",
    margins: {
      top: clampNum(marginsIn.top, STYLE_BOUNDS.margin.min, STYLE_BOUNDS.margin.max, STYLE_BOUNDS.margin.default),
      bottom: clampNum(marginsIn.bottom, STYLE_BOUNDS.margin.min, STYLE_BOUNDS.margin.max, STYLE_BOUNDS.margin.default),
      left: clampNum(marginsIn.left, STYLE_BOUNDS.margin.min, STYLE_BOUNDS.margin.max, STYLE_BOUNDS.margin.default),
      right: clampNum(marginsIn.right, STYLE_BOUNDS.margin.min, STYLE_BOUNDS.margin.max, STYLE_BOUNDS.margin.default),
    },
    header: {
      logo: boolOr(headerIn.logo, d.header.logo),
      company: boolOr(headerIn.company, d.header.company),
      address: boolOr(headerIn.address, d.header.address),
      contact: boolOr(headerIn.contact, d.header.contact),
      docNumber: boolOr(headerIn.docNumber, d.header.docNumber),
      date: boolOr(headerIn.date, d.header.date),
      meta: boolOr(headerIn.meta, d.header.meta),
    },
    footer: {
      pageNumber: boolOr(footerIn.pageNumber, d.footer.pageNumber),
      generatedDate: boolOr(footerIn.generatedDate, d.footer.generatedDate),
      contact: boolOr(footerIn.contact, d.footer.contact),
      customText: typeof footerIn.customText === "string" ? footerIn.customText.slice(0, 120) : d.footer.customText,
    },
  };
}

/** Publish-time readability checks (§16) — empty array means readable. */
export function styleReadabilityWarnings(style: TemplateStyle): string[] {
  const warnings: string[] = [];
  if (contrastAgainstWhite(style.primaryColor) < 2.2) {
    warnings.push("Primary color is too light — white table-header text would be unreadable on it.");
  }
  if (contrastAgainstWhite(style.textColor) < 8) {
    warnings.push("Text color is too light to read comfortably on white paper.");
  }
  return warnings;
}
