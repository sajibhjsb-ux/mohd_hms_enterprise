// MOHD.HMS ENTERPRISE — Central PDF layout engine (§5 PDFService / §18 A4 design).
//
// ONE shared engine for every business document: brand header, page footers
// with "Page X of Y", word-wrapped text, multi-line tables with repeated
// headers across pages, totals blocks, key/value grids, signature lines and
// aspect-ratio-preserving images. Built on pdf-lib (MIT) — no license key,
// no native dependency, runs inside the existing Next.js business layer.
//
// Template support (Settings → Templates, spec §15-§20): every visual knob an
// administrator may customize (brand colors, standard fonts, body size, line
// spacing, orientation, page margins, header/footer toggles) is injected via
// `PdfDoc.create(..., style)`. With no style (or the default style) the engine
// renders BYTE-EQUIVALENT to the historical built-in layout — existing
// documents keep their exact look (§55).
//
// Money/values MUST be pre-formatted through the central formatters in
// `@/lib/hms/format` (BND) before they reach this engine.

import "server-only";
import { PDFDocument, StandardFonts, rgb, type Color, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { fmtDateTime } from "@/lib/hms/format";
import { DEFAULT_TEMPLATE_STYLE, type TemplateStyle, type TemplateFont } from "./template-style";

// Neutral palette (unchanged by templates — template colors drive brand only).
const MUTED = rgb(0.42, 0.45, 0.49);
const FAINT = rgb(0.62, 0.65, 0.68);
const ZEBRA = rgb(0.968, 0.976, 0.972);
const DANGER = rgb(0.7, 0.15, 0.15);
const WHITE = rgb(1, 1, 1);

// Characters safe for the standard WinAnsi fonts; everything else is replaced.
// Unicode look-alikes that have WinAnsi equivalents are mapped (− → -, · kept,
// non-breaking space → space) so values render professionally instead of "?".
const WINANSI_SAFE = /^[\u0000-\u007F\u00A0\u00B7\u2018\u2019\u201A\u201C\u201D\u201E\u2013\u2014\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC]$/;
const CHAR_MAP: Record<string, string> = {
  "\u2212": "-", // minus sign → hyphen
  "\u2011": "-", // non-breaking hyphen
  "\u00A0": " ", // non-breaking space
  "\u2010": "-",
};

export function pdfText(input: string | null | undefined): string {
  const raw = String(input ?? "");
  let out = "";
  for (const ch of raw) {
    if (ch === "\t") {
      out += "  ";
    } else if (ch === "\n" || ch === "\r") {
      out += "\n";
    } else if (CHAR_MAP[ch]) {
      out += CHAR_MAP[ch];
    } else if (WINANSI_SAFE.test(ch)) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

/** Flatten to ONE physical line: explicit line breaks and collapsed whitespace
 *  become single spaces. Use for text that must occupy exactly one row
 *  (titles, numbers, metadata values, captions). pdf-lib's
 *  widthOfTextAtSize() THROWS on "\n" (WinAnsi cannot encode 0x0A), so any
 *  string that reaches a measuring call must be single-line or pre-split. */
export function singleLine(input: string | null | undefined): string {
  return pdfText(input).replace(/\s+/g, " ").trim();
}

export class PdfGenerationError extends Error {
  detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.detail = detail;
  }
}

export type TableCol = {
  header: string;
  width: number; // relative weight
  align?: "left" | "right" | "center";
};

export type TableCell = { text: string; bold?: boolean };

export type DocHeaderInfo = {
  company: string;
  contactLines: string[];
  /** Template header toggles (§20) — when present the header draws the address
   *  lines and the contact line SEPARATELY so each can be toggled; when absent
   *  the combined contactLines render as before. */
  addressLines?: string[];
  contactLine?: string;
  docTitle: string; // e.g. "WORK ORDER"
  docNumber: string; // e.g. WO-2026-0002
  docDateLabel: string; // e.g. "Issued 12 Feb 2026"
  meta?: [string, string][]; // extra right-column lines under the date
};

const A4W = 595.28;
const A4H = 841.89;
const BASE_MARGIN = 46;

// Only pdf-lib standard (WinAnsi-safe) families are embeddable (§17) — any
// other family would throw at generation time.
const FONT_FAMILIES: Record<TemplateFont, [StandardFonts, StandardFonts]> = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  "Times-Roman": [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold],
};

function hexToRgb(hex: string, fallback: Color): Color {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export class PdfDoc {
  private pdf!: PDFDocument;
  private font!: PDFFont;
  private bold!: PDFFont;
  private page!: PDFPage;
  private pages: PDFPage[] = [];
  private y = 0;
  private logo: PDFImage | null = null;
  private footerLabel = "MOHD.HMS ENTERPRISE";
  // Per-page ink extents (bottom-most ink y, right-most ink x) recorded by the
  // drawing primitives. Used for placement decisions that must guarantee no
  // overlap with already-drawn content (e.g. the QR verification band) — the
  // engine can then co-locate fixed-position elements on the current page
  // whenever the occupied region demonstrably cannot collide (§8/§36).
  private inkBars: { bottom: number; right: number }[] = [];
  // Header geometry — measured by drawHeader() from the actual content, so the
  // brand rule and the body start adapt to any content height (no fixed
  // offsets that could let the rule overlap text). Defaults only apply until
  // the first page's header has been measured.
  private headerRuleY = A4H - 92;
  private bodyTop = A4H - 116;

  // ── Template-driven geometry & palette (§15-§20) ─────────────────────────
  private PW = A4W; // page width (orientation-aware)
  private PH = A4H; // page height (orientation-aware)
  private ML = BASE_MARGIN; // left margin
  private MR = BASE_MARGIN; // right margin
  private topExtra = 0; // extra top margin beyond the header's built-in pad
  private botExtra = 0; // extra bottom margin beyond the footer floor
  private tscale = 1; // body text scale from baseFontSize
  private LH = 1; // line-height multiplier
  private hc: TemplateStyle["header"] = { ...DEFAULT_TEMPLATE_STYLE.header };
  private fc: TemplateStyle["footer"] = { ...DEFAULT_TEMPLATE_STYLE.footer };
  // Brand palette — template-configurable (§16); defaults = historical values.
  private cInk = rgb(0.13, 0.15, 0.17);
  private cLine = rgb(0.84, 0.86, 0.88);
  private cPrimary = rgb(0.082, 0.42, 0.235);
  private cPrimaryInk = rgb(0.05, 0.3, 0.16);
  private cPrimarySoft = rgb(0.906, 0.949, 0.918);

  readonly W = A4W;
  readonly H = A4H;

  private constructor() {}

  get M(): number {
    return this.ML;
  }
  get contentW(): number {
    return this.PW - this.ML - this.MR;
  }

  /** Scaled body text size (§17 typography). */
  private sz(base: number): number {
    return Math.round(base * this.tscale * 10) / 10;
  }

  static async create(header: DocHeaderInfo, logoBytes?: Buffer | null, style?: TemplateStyle): Promise<PdfDoc> {
    const d = new PdfDoc();
    const st = style ?? DEFAULT_TEMPLATE_STYLE;

    // ── geometry (§18/§19) ──
    if (st.orientation === "landscape") {
      d.PW = A4H;
      d.PH = A4W;
    }
    d.ML = st.margins.left;
    d.MR = st.margins.right;
    d.topExtra = Math.max(0, st.margins.top - BASE_MARGIN);
    d.botExtra = Math.max(0, st.margins.bottom - BASE_MARGIN);
    d.tscale = st.baseFontSize / 9;
    d.LH = st.lineHeight;
    d.hc = { ...st.header };
    d.fc = { ...st.footer };

    // ── palette (§16) — brand colors only; neutrals stay fixed ──
    d.cInk = hexToRgb(st.textColor, d.cInk);
    d.cLine = hexToRgb(st.borderColor, d.cLine);
    d.cPrimary = hexToRgb(st.primaryColor, d.cPrimary);
    // Derived tones keep the historical relationships (primaryInk darker for
    // emphasis text, primarySoft a ~10% wash for accent bands).
    d.cPrimaryInk = rgb(
      d.cPrimary.red * 0.62,
      Math.min(1, d.cPrimary.green * 0.68),
      d.cPrimary.blue * 0.66
    );
    d.cPrimarySoft = rgb(
      1 - (1 - d.cPrimary.red) * 0.1,
      1 - (1 - d.cPrimary.green) * 0.1,
      1 - (1 - d.cPrimary.blue) * 0.1
    );

    d.pdf = await PDFDocument.create();
    d.pdf.setTitle(`${header.company} — ${header.docTitle} ${header.docNumber}`);
    d.pdf.setAuthor(header.company);
    d.pdf.setCreator("MOHD.HMS ENTERPRISE / FacilityPro");
    d.pdf.setProducer("FacilityPro PDF Service (pdf-lib)");
    const [regular, bold] = FONT_FAMILIES[st.fontFamily] ?? FONT_FAMILIES.Helvetica;
    d.font = await d.pdf.embedFont(regular);
    d.bold = await d.pdf.embedFont(bold);
    if (logoBytes && logoBytes.length > 0) {
      try {
        d.logo = await d.pdf.embedPng(logoBytes);
      } catch {
        d.logo = null; // a broken logo must never fail the document
      }
    }
    d.addPage();
    d.drawHeader(header);
    return d;
  }

  private addPage(): void {
    this.page = this.pdf.addPage([this.PW, this.PH]);
    this.pages.push(this.page);
    this.y = this.bodyTop;
    this.inkBars = [];
  }

  /** Record the ink extent of a drawn element (conservative upper bounds). */
  private recordInk(bottom: number, right: number): void {
    this.inkBars.push({ bottom, right: Math.min(right, this.PW - this.MR) });
  }

  /** Truncate to a pixel width (never mid-glyph overflow); adds an ellipsis.
   *  Newline-safe: each physical line is fitted independently — pdf-lib's
   *  widthOfTextAtSize() throws on "\n", so a multi-line input is measured
   *  and fitted line by line (drawText renders the joined result correctly). */
  private fitText(text: string, font: PDFFont, size: number, maxW: number): string {
    return text
      .split("\n")
      .map((ln) => this.fitSingleLine(ln, font, size, maxW))
      .join("\n");
  }

  private fitSingleLine(text: string, font: PDFFont, size: number, maxW: number): string {
    if (font.widthOfTextAtSize(text, size) <= maxW) return text;
    let line = text;
    while (line.length > 1 && font.widthOfTextAtSize(line + "\u2026", size) > maxW) line = line.slice(0, -1);
    return line + "\u2026";
  }

  /**
   * Brand header (§17) — a measured, flex-like layout (align-items: center):
   *
   *   [LOGO]  COMPANY NAME            DOC TITLE
   *           address                  DOC-NUMBER
   *           phone · email            Label : value
   *                                    Label : value
   *  ───────────────── green rule ───────────────────
   *
   * The rule is positioned BELOW the tallest of (logo, company block, document
   * block) with a safe gap, so it can never overlap text regardless of how
   * long the address, title, number, status or metadata become. The logo and
   * both text blocks are vertically centered against one shared container.
   * Every element honours its template header toggle (§20); hiding elements
   * shrinks the measured container — never a fixed-height hole.
   */
  private drawHeader(h: DocHeaderInfo): void {
    const p = this.page;
    const TOP_PAD = 26 + this.topExtra; // page top edge → header content top (§19 margins)
    const RULE_GAP = 12; // lowest header content → green rule (never zero)
    const BODY_GAP = 22; // green rule → first body content
    const LOGO_BOX = 48; // official logo inside a 48pt square, aspect preserved

    // ── LEFT block: company identity ────────────────────────────────
    const COMPANY_SIZE = 12.5;
    const CONTACT_SIZE = 7.6;
    const COMPANY_LH = 15;
    const CONTACT_LH = 10.6;
    // Company name first (toggleable), then address lines, then the contact
    // line — address and contact are toggled SEPARATELY (§20). When the
    // split fields are absent the combined contactLines render as before.
    const company = this.hc.company ? singleLine(h.company).slice(0, 42) : "";
    let contact: string[];
    if (h.addressLines || h.contactLine !== undefined) {
      contact = [
        ...(this.hc.address ? (h.addressLines ?? []).flatMap((l) => pdfText(l).split("\n")) : []),
        ...(this.hc.contact ? [pdfText(h.contactLine ?? "")] : []),
      ]
        .map((l) => l.trim())
        .filter(Boolean);
    } else {
      contact = this.hc.address && this.hc.contact
        ? h.contactLines.flatMap((l) => pdfText(l).split("\n")).map((l) => l.trim()).filter(Boolean)
        : [];
    }
    const leftH = (company ? COMPANY_LH + 13 : 0) + contact.length * CONTACT_LH;

    // ── RIGHT block: document identity ──────────────────────────────
    const TITLE_SIZE = 15;
    const NUM_SIZE = 10.5;
    const META_SIZE = 8.6;
    const TITLE_LH = 18;
    const NUM_LH = 13.5;
    const META_LH = 11.4;
    const meta: [string, string][] = [];
    const dl = this.hc.date ? singleLine(h.docDateLabel) : "";
    if (dl) {
      // docDateLabel is built as "<Verb> <date>" (Dated/Issued/Received/…) —
      // render it as the first column-aligned metadata row.
      const sp = dl.indexOf(" ");
      meta.push(sp > 0 ? [dl.slice(0, sp), dl.slice(sp + 1).trim()] : [dl, ""]);
    }
    if (this.hc.meta) for (const [k, v] of (h.meta ?? []).slice(0, 4)) meta.push([singleLine(k), singleLine(v ?? "")]);
    const rightH = TITLE_LH + (this.hc.docNumber ? NUM_LH : 0) + meta.length * META_LH;

    // ── Shared container — all three blocks vertically centered ─────
    const containerH = Math.max(leftH, rightH, this.hc.logo ? LOGO_BOX : 0, TITLE_LH + 12);
    const contentTop = this.PH - TOP_PAD;
    const centerY = contentTop - containerH / 2;
    const contentBottom = contentTop - containerH;

    // Right metadata geometry first — it defines how much width the left
    // block may safely use (prevents any left/right collision).
    const META_VALUE_MAX = 170;
    const metaRows = meta.map(([k, v]) => ({
      label: `${k} :`,
      value: this.fitText(v, this.font, META_SIZE, META_VALUE_MAX),
    }));
    const maxValueW = metaRows.reduce((s, r) => Math.max(s, this.font.widthOfTextAtSize(r.value, META_SIZE)), 0);
    const valueX = this.PW - this.MR - maxValueW; // value column left edge
    const META_LABEL_GAP = 8;

    // LOGO — vertically centered against the full header block.
    let textX = this.ML;
    if (this.hc.logo) {
      if (this.logo) {
        const dim = this.logo.scaleToFit(LOGO_BOX, LOGO_BOX);
        p.drawImage(this.logo, { x: this.ML, y: centerY - dim.height / 2, width: dim.width, height: dim.height });
      } else {
        p.drawRectangle({ x: this.ML, y: centerY - 20, width: 40, height: 40, color: this.cPrimary });
        p.drawText("MH", { x: this.ML + 9, y: centerY - 6, size: 15, font: this.bold, color: WHITE });
      }
      textX = this.ML + LOGO_BOX + 12;
    }

    // COMPANY TEXT — vertically centered, right of the logo, width-capped so
    // it can never reach the document block.
    const leftMaxW = Math.max(120, valueX - META_LABEL_GAP - textX - 24);
    const leftTop = centerY + leftH / 2;
    let ly = leftTop - (company ? 10.8 : 0);
    if (company) {
      p.drawText(this.fitText(company, this.bold, COMPANY_SIZE, leftMaxW), {
        x: textX,
        y: ly,
        size: COMPANY_SIZE,
        font: this.bold,
        color: this.cPrimaryInk,
      });
      ly -= 13;
    }
    for (const line of contact) {
      p.drawText(this.fitText(line, this.font, CONTACT_SIZE, leftMaxW), { x: textX, y: ly, size: CONTACT_SIZE, font: this.font, color: MUTED });
      ly -= CONTACT_LH;
    }

    // DOCUMENT TEXT — title + number right-aligned; metadata as a
    // column-aligned "Label : Value" block anchored to the page margin.
    const rightTop = centerY + rightH / 2;
    let ry = rightTop - 12.8; // title baseline
    const title = this.fitText(singleLine(h.docTitle).toUpperCase(), this.bold, TITLE_SIZE, leftMaxW + (this.hc.logo ? LOGO_BOX + 12 : 0));
    p.drawText(title, { x: this.PW - this.MR - this.bold.widthOfTextAtSize(title, TITLE_SIZE), y: ry, size: TITLE_SIZE, font: this.bold, color: this.cInk });
    ry -= NUM_LH;
    if (this.hc.docNumber) {
      const num = singleLine(h.docNumber);
      p.drawText(num, { x: this.PW - this.MR - this.bold.widthOfTextAtSize(num, NUM_SIZE), y: ry, size: NUM_SIZE, font: this.bold, color: this.cPrimaryInk });
      ry -= 12;
    }
    metaRows.forEach((r, i) => {
      const baseline = ry - i * META_LH;
      p.drawText(r.label, {
        x: valueX - META_LABEL_GAP - this.font.widthOfTextAtSize(r.label, META_SIZE),
        y: baseline,
        size: META_SIZE,
        font: this.font,
        color: MUTED,
      });
      p.drawText(r.value, { x: valueX, y: baseline, size: META_SIZE, font: this.font, color: this.cInk });
    });

    // GREEN BRAND RULE — below ALL header content, never inside it.
    const ruleY = contentBottom - RULE_GAP;
    p.drawRectangle({ x: this.ML, y: ruleY, width: this.contentW, height: 2.6, color: this.cPrimary });
    this.headerRuleY = ruleY;
    this.bodyTop = ruleY - BODY_GAP;
    this.y = this.bodyTop;
  }

  private get floorY(): number {
    return this.ML + 30 + this.botExtra;
  }

  private ensure(h: number): void {
    if (this.y - h < this.floorY) this.addPage();
  }

  spacer(h = 10): void {
    this.y -= h;
  }

  divider(color?: Color): void {
    this.ensure(14);
    this.y -= 7;
    this.page.drawLine({ start: { x: this.ML, y: this.y }, end: { x: this.PW - this.MR, y: this.y }, thickness: 0.8, color: color ?? this.cLine });
    this.y -= 7;
    this.recordInk(this.y, this.PW - this.MR);
  }

  /** Section heading with green square marker.
   *  keepWithNext (pt) reserves room for the START of the block that follows
   *  (§7 keep-together): when the following block could not even begin on the
   *  current page, the page breaks BEFORE the heading is drawn, so a heading
   *  is never orphaned at the bottom of a page. 0 keeps the plain behaviour. */
  heading(text: string, opts?: { keepWithNext?: number }): void {
    const size = this.sz(10.5);
    this.ensure(26 + Math.max(0, opts?.keepWithNext ?? 0));
    this.y -= 18;
    this.page.drawRectangle({ x: this.ML, y: this.y - 1.5, width: 7, height: 7, color: this.cPrimary });
    const label = pdfText(text);
    this.page.drawText(label, { x: this.ML + 12, y: this.y, size, font: this.bold, color: this.cInk });
    this.recordInk(this.y - 3, this.ML + 12 + this.bold.widthOfTextAtSize(label, size));
    this.y -= 8;
  }

  /** Wrapped paragraph. */
  para(
    text: string,
    opts?: { size?: number; bold?: boolean; color?: "ink" | "muted" | "faint" | "green" | "danger"; gap?: number; indent?: number }
  ): void {
    const size = this.sz(opts?.size ?? 9);
    const font = opts?.bold ? this.bold : this.font;
    const color =
      opts?.color === "muted" ? MUTED : opts?.color === "faint" ? FAINT : opts?.color === "green" ? this.cPrimaryInk : opts?.color === "danger" ? DANGER : this.cInk;
    const indent = opts?.indent ?? 0;
    const lines = this.wrap(pdfText(text), font, size, this.contentW - indent);
    const step = (size + 3.2) * this.LH;
    for (const ln of lines) {
      this.ensure(size + 4);
      this.y -= step;
      this.page.drawText(ln, { x: this.ML + indent, y: this.y, size, font, color });
      this.recordInk(this.y - 2.5, this.ML + indent + font.widthOfTextAtSize(ln, size));
    }
    this.y -= opts?.gap ?? 2;
  }

  /** Label/value grid (2 columns by default) — values wrap. */
  kvGrid(pairs: [string, string][], opts?: { cols?: 1 | 2 | 3 }): void {
    const cols = opts?.cols ?? 2;
    const colW = this.contentW / cols;
    const valueSize = this.sz(9);
    const step = 11.5 * this.LH;
    for (let i = 0; i < pairs.length; i += cols) {
      const rowPairs = pairs.slice(i, i + cols);
      let maxH = 0;
      const rendered = rowPairs.map(([label, value]) => {
        const valueLines = this.wrap(pdfText(value), this.font, valueSize, colW - 14);
        return { label, valueLines, h: 11 + valueLines.length * step + 7 };
      });
      for (const r of rendered) maxH = Math.max(maxH, r.h);
      this.ensure(maxH + 2);
      const yTop = this.y;
      rendered.forEach((r, idx) => {
        const x = this.ML + idx * colW;
        this.page.drawText(pdfText(r.label).toUpperCase().slice(0, 32), { x, y: yTop - 8, size: 7.2, font: this.bold, color: FAINT });
        r.valueLines.forEach((ln, li) => {
          this.page.drawText(ln, { x, y: yTop - 18 - li * step, size: valueSize, font: this.font, color: this.cInk });
        });
      });
      this.y = yTop - maxH;
      this.recordInk(this.y, this.PW - this.MR);
    }
  }

  /** Multi-line table with repeated headers across page breaks (§18).
   *  Cells may be plain strings or { text, bold } objects. */
  table(columns: TableCol[], rows: (string | TableCell)[][], opts?: { zebra?: boolean; emptyHint?: string }): void {
    const totalWeight = columns.reduce((s, c) => s + c.width, 0) || 1;
    const colX: number[] = [];
    const colW: number[] = [];
    let acc = this.ML;
    for (const c of columns) {
      colX.push(acc);
      colW.push((c.width / totalWeight) * this.contentW);
      acc += colW[colW.length - 1];
    }

    const cellSize = this.sz(8.5);
    const step = 11 * this.LH;

    const drawHeaderRow = () => {
      const hH = 19;
      this.page.drawRectangle({ x: this.ML, y: this.y - hH, width: this.contentW, height: hH, color: this.cPrimary });
      columns.forEach((c, i) => {
        const label = singleLine(c.header);
        const w = this.bold.widthOfTextAtSize(label, 8);
        const x = c.align === "right" ? colX[i] + colW[i] - w - 6 : c.align === "center" ? colX[i] + (colW[i] - w) / 2 : colX[i] + 6;
        this.page.drawText(label, { x, y: this.y - hH + 6, size: 8, font: this.bold, color: WHITE });
      });
      this.y -= hH;
      this.recordInk(this.y, this.PW - this.MR);
    };

    this.ensure(40);
    drawHeaderRow();

    if (rows.length === 0 && opts?.emptyHint) {
      this.ensure(20);
      this.y -= 16;
      this.page.drawText(pdfText(opts.emptyHint), { x: this.ML + 6, y: this.y, size: cellSize, font: this.font, color: FAINT });
      return;
    }

    rows.forEach((row, ri) => {
      // Pre-wrap all cells to measure the row height.
      const cells = row.map((cell, i) => {
        const c = columns[i];
        const bold = typeof cell === "object" && cell.bold;
        const text = pdfText(typeof cell === "string" ? cell : cell.text);
        const font = bold ? this.bold : this.font;
        return { text, font, lines: this.wrap(text, font, cellSize, colW[i] - 12) };
      });
      const maxLines = Math.max(1, ...cells.map((c) => c.lines.length));
      const rowH = maxLines * step + 7;

      if (this.y - rowH < this.floorY) {
        this.addPage();
        drawHeaderRow(); // repeated header on every continued page
      }

      if (opts?.zebra !== false && ri % 2 === 1) {
        this.page.drawRectangle({ x: this.ML, y: this.y - rowH, width: this.contentW, height: rowH, color: ZEBRA });
      }

      cells.forEach((cell, i) => {
        const c = columns[i];
        cell.lines.forEach((ln, li) => {
          const lineW = cell.font.widthOfTextAtSize(ln, cellSize);
          const x = c.align === "right" ? colX[i] + colW[i] - lineW - 6 : c.align === "center" ? colX[i] + (colW[i] - lineW) / 2 : colX[i] + 6;
          this.page.drawText(ln, { x, y: this.y - step - li * step, size: cellSize, font: cell.font, color: this.cInk });
        });
      });
      this.y -= rowH;
      // faint row separator
      this.page.drawLine({ start: { x: this.ML, y: this.y }, end: { x: this.PW - this.MR, y: this.y }, thickness: 0.4, color: this.cLine });
      this.recordInk(this.y, this.PW - this.MR);
    });
    this.y -= 4;
  }

  /** Right-aligned totals block; the last row is the emphasized grand total. */
  totals(rows: [string, string][], opts?: { accent?: boolean }): void {
    const blockW = 250;
    const x0 = this.PW - this.MR - blockW;
    this.ensure(rows.length * 16 + 14);
    this.y -= 4;
    rows.forEach(([label, value], i) => {
      const isLast = i === rows.length - 1;
      if (isLast && opts?.accent !== false) {
        this.page.drawRectangle({ x: x0 - 8, y: this.y - 16, width: blockW + 8, height: 20, color: this.cPrimarySoft });
      }
      const size = this.sz(isLast ? 10 : 9);
      const f = isLast ? this.bold : this.font;
      const v = singleLine(value);
      const vw = f.widthOfTextAtSize(v, size);
      this.page.drawText(singleLine(label), { x: x0, y: this.y - 12, size, font: f, color: isLast ? this.cPrimaryInk : MUTED });
      this.page.drawText(v, { x: x0 + blockW - vw, y: this.y - 12, size, font: f, color: isLast ? this.cPrimaryInk : this.cInk });
      this.y -= isLast ? 22 : 16;
    });
    this.recordInk(this.y, x0 + blockW);
  }

  /** Full-width single line label/value banner (status lines). */
  banner(text: string, tone: "green" | "danger" | "muted" = "green"): void {
    this.ensure(24);
    this.y -= 6;
    const h = 19;
    this.page.drawRectangle({
      x: this.ML,
      y: this.y - h + 4,
      width: this.contentW,
      height: h,
      color: tone === "green" ? this.cPrimarySoft : tone === "danger" ? rgb(0.96, 0.92, 0.92) : rgb(0.95, 0.95, 0.955),
    });
    this.page.drawText(singleLine(text), {
      x: this.ML + 8,
      y: this.y - 8.5 + 4,
      size: this.sz(8.8),
      font: this.bold,
      color: tone === "green" ? this.cPrimaryInk : tone === "danger" ? DANGER : MUTED,
    });
    this.y -= h + 8;
    this.recordInk(this.y + 4, this.PW - this.MR);
  }

  /** Signature lines (§18) — up to 3 side-by-side. */
  signatures(items: { caption: string; name?: string }[]): void {
    if (items.length === 0) return;
    this.ensure(84);
    this.y -= 46;
    const slotW = this.contentW / Math.min(3, Math.max(1, items.length));
    items.slice(0, 3).forEach((s, i) => {
      const x = this.ML + i * slotW + 8;
      const lineW = Math.min(170, slotW - 30);
      this.page.drawLine({ start: { x, y: this.y }, end: { x: x + lineW, y: this.y }, thickness: 0.9, color: MUTED });
      if (s.name) {
        this.page.drawText(pdfText(s.name).slice(0, 40), { x, y: this.y + 5, size: 8.5, font: this.bold, color: this.cInk });
      }
      this.page.drawText(pdfText(s.caption).slice(0, 44), { x, y: this.y - 11, size: 7.5, font: this.font, color: MUTED });
    });
    this.y -= 18;
    const slotCount = Math.min(3, Math.max(1, items.length));
    this.recordInk(this.y, this.ML + (slotCount - 1) * (this.contentW / slotCount) + 8 + Math.min(170, this.contentW / slotCount - 30));
  }

  /** Notes/terms block rendered as a titled section. */
  notesBlock(title: string, body: string): void {
    if (!body?.trim()) return;
    this.heading(title, { keepWithNext: 24 });
    this.para(body, { size: 8.8, color: "muted" });
  }

  /** Aspect-ratio-preserving image (§19) — contain-fit inside the box. */
  async image(bytes: Buffer | Uint8Array, opts: { maxW?: number; maxH?: number; caption?: string }): Promise<void> {
    if (!bytes || bytes.length === 0) return;
    let img: PDFImage;
    try {
      img = await this.pdf.embedPng(bytes);
    } catch {
      try {
        img = await this.pdf.embedJpg(bytes);
      } catch {
        return; // unsupported image must never fail the document
      }
    }
    const maxW = opts.maxW ?? 200;
    const maxH = opts.maxH ?? 150;
    const dim = img.scaleToFit(maxW, maxH);
    this.ensure(dim.height + (opts.caption ? 14 : 0) + 12);
    this.y -= dim.height + 6;
    this.page.drawImage(img, { x: this.ML, y: this.y, width: dim.width, height: dim.height });
    if (opts.caption) {
      this.y -= 12;
      this.page.drawText(singleLine(opts.caption).slice(0, 90), { x: this.ML, y: this.y, size: 7.5, font: this.font, color: MUTED });
    }
    this.y -= 6;
    this.recordInk(this.y, this.ML + dim.width);
  }

  // ── IRMS photo-grid / QR / signature-image extensions (contract §17) ──────

  private async embed(bytes: Buffer | Uint8Array): Promise<PDFImage | null> {
    try {
      return await this.pdf.embedPng(bytes);
    } catch {
      try {
        return await this.pdf.embedJpg(bytes);
      } catch {
        return null;
      }
    }
  }

  /** Professional photo-row geometry (§9/§10/§12). One row = 3 cards of
   *  [image box + caption strip], separated by consistent gaps. The row
   *  height is derived from the MEASURED body top so exactly 3 rows fill a
   *  fresh page (§14) — no per-report or per-page size variation, and no
   *  hardcoded offsets that could collide with the header or footer. */
  private photoRowMetrics(): { rowH: number; cellW: number; imgW: number; imgH: number; gap: number; floorY: number } {
    const gap = 7; // card → card spacing, horizontal and vertical (§12: 6–10pt)
    const floorY = this.floorY; // footer clearance — same floor as ensure()
    const cellW = (this.contentW - 2 * gap) / 3;
    const rowH = Math.floor(((this.bodyTop - floorY) - 2 * gap) / 3); // 3 rows fill a fresh page
    const imgH = rowH - 34; // caption strip (number + caption) keeps its proven 34pt
    return { rowH, cellW, imgW: cellW - 12, imgH, gap, floorY };
  }

  /** One row of ≤3 photo cards at (yTop → yTop - rowH). Contain-fit images
   *  (never distorted §11), placeholder cell for a missing file, number +
   *  caption strip under each image (§13). */
  private async drawPhotoRow(
    cells: { caption: string; number: string; bytes: Buffer | Uint8Array | null }[],
    yTop: number,
    m: { rowH: number; cellW: number; imgW: number; imgH: number; gap: number }
  ): Promise<void> {
    for (let i = 0; i < Math.min(3, cells.length); i++) {
      const cell = cells[i];
      const x = this.ML + i * (m.cellW + m.gap);

      this.page.drawRectangle({
        x,
        y: yTop - m.rowH + 2,
        width: m.cellW,
        height: m.rowH - 4,
        borderColor: this.cLine,
        borderWidth: 0.7,
      });

      let drew = false;
      if (cell.bytes && cell.bytes.length > 0) {
        const img = await this.embed(cell.bytes);
        if (img) {
          const dim = img.scaleToFit(m.imgW, m.imgH);
          const ix = x + (m.cellW - dim.width) / 2;
          const iy = yTop - 8 - m.imgH + (m.imgH - dim.height) / 2;
          this.page.drawImage(img, { x: ix, y: iy, width: dim.width, height: dim.height });
          drew = true;
        }
      }
      if (!drew) {
        this.page.drawRectangle({ x: x + 7, y: yTop - 8 - m.imgH, width: m.cellW - 14, height: m.imgH, color: ZEBRA });
        const t = "Photo file unavailable";
        const tw = this.font.widthOfTextAtSize(t, 8);
        this.page.drawText(t, { x: x + (m.cellW - tw) / 2, y: yTop - 8 - m.imgH / 2 + 3, size: 8, font: this.font, color: FAINT });
      }

      // Number (bold) + caption in the strip under the cell (§13).
      const capY = yTop - m.rowH + 14;
      const numText = singleLine(cell.number).slice(0, 12);
      this.page.drawText(numText, { x: x + 6, y: capY, size: 8, font: this.bold, color: this.cPrimaryInk });
      const numW = this.bold.widthOfTextAtSize(numText, 8) + 6;
      const caption = singleLine(cell.caption || "—");
      const maxCw = m.cellW - numW - 14;
      let line = caption.slice(0, 60);
      while (line.length > 1 && this.font.widthOfTextAtSize(line, 7.5) > maxCw) line = line.slice(0, -1);
      if (caption.length > line.length) line = line.slice(0, -1) + "…";
      this.page.drawText(line, { x: x + 6 + numW, y: capY, size: 7.5, font: this.font, color: MUTED });
    }
  }

  /**
   * Flowing photo grid (§6/§7/§8/§14/§20/§21) — THE photo engine for every
   * inspection report. Each inner array is one category page-group (the
   * renderer keeps categories in canonical order); the engine decides ALL
   * placement:
   *
   *   • keep-together (§7/§8): the section heading is drawn directly above
   *     its first photo row — when heading + one row cannot fit on the
   *     current page, the whole logical block moves to the next page BEFORE
   *     anything is drawn, so a heading is never orphaned.
   *   • dynamic pagination (§14): complete rows flow onto the current page
   *     while they fit; the remainder continues on the next page. Sections
   *     are never forced onto a dedicated page, and a short section no
   *     longer reserves a full-page 3×3 area (§15: no fixed photo-area
   *     heights — the old full-page reservation wasted 40–75% of pages).
   *   • professional size (§10): row geometry is fixed from the measured
   *     body top — photos keep the same size on every page and report.
   */
  async photoGrid(pages: { caption: string; number: string; bytes: Buffer | Uint8Array | null }[][], opts?: { heading?: string }): Promise<void> {
    const m = this.photoRowMetrics();
    let headingPending = opts?.heading?.trim() ?? "";

    for (const cells of pages) {
      if (!cells || cells.length === 0) continue;

      // §7/§8 — heading travels with its first row.
      if (headingPending) {
        if (this.y - (26 + m.rowH) < m.floorY) this.addPage();
        this.heading(headingPending);
        headingPending = "";
      }

      let i = 0;
      while (i < cells.length) {
        const rowsLeft = Math.ceil((cells.length - i) / 3);
        let rowsHere = Math.min(Math.floor((this.y - m.floorY + m.gap) / (m.rowH + m.gap)), rowsLeft);
        if (rowsHere <= 0) {
          this.addPage();
          rowsHere = Math.min(Math.floor((this.y - m.floorY + m.gap) / (m.rowH + m.gap)), rowsLeft);
        }
        for (let r = 0; r < rowsHere; r++) {
          // Row top: leave the gap above every row except the first on the page.
          const rowTop = r === 0 ? this.y : this.y - m.gap;
          await this.drawPhotoRow(cells.slice(i, i + 3), rowTop, m);
          this.y = rowTop - m.rowH;
          this.recordInk(this.y, this.PW - this.MR);
          i += 3;
        }
      }
    }
    if (headingPending === "" && pages.some((c) => c && c.length > 0)) {
      this.y -= 8; // §35: consistent section bottom spacing before the next block
    }
  }

  /** Central PDF QR component (ch.35 spec §21/§22/§23/§24/§43/§44) — THE one
   *  QR placement used by EVERY document renderer (§67: no per-renderer QR
   *  logic). Bottom-right of the last page by default (§24 — one QR per
   *  document), or page 1 with placement:"first". The verification band is
   *  reserved through the page-break floor, so totals, signatures, tables and
   *  footers can never be overlapped (§23). Print-grade sizing (78pt) with
   *  ECC-H source images stays readable after A4 printing and photocopying. */
  async qr(png: Buffer | Uint8Array, opts?: { caption?: string; reference?: string; placement?: "first" | "last"; size?: number }): Promise<void> {
    if (!png || png.length === 0) return;
    const img = await this.embed(png);
    if (!img) return;
    const size = Math.min(110, Math.max(54, opts?.size ?? 78));
    const caption = singleLine(opts?.caption ?? "Scan to Verify").slice(0, 44);
    const ref = opts?.reference ? singleLine(opts.reference).slice(0, 30) : "";

    // Last-page placement (default): the plate lives at its fixed bottom-right
    // position; a fresh final page is added ONLY when already-drawn ink
    // genuinely intersects the QR band (plate + side caption corridor). Short
    // left-aligned lines (e.g. the revision note) do not reach the corridor,
    // so the QR joins the current page instead of wasting one (§8/§36).
    const x = this.PW - this.MR - size;
    if (opts?.placement !== "first") {
      const zoneTop = 50 + size + 3;
      const corridorLeft = x - 14 - Math.max(this.bold.widthOfTextAtSize(caption, 7.5), ref ? this.font.widthOfTextAtSize(ref, 7) : 0);
      const collides = this.inkBars.some((b) => b.bottom < zoneTop + 2 && b.right > corridorLeft);
      if (collides) this.addPage();
    }
    const page = opts?.placement === "first" ? this.pages[0] : this.page;
    const y = 50;
    // white plate + hairline border guarantees contrast on any paper (§44)
    page.drawRectangle({ x: x - 3, y: y - 3, width: size + 6, height: size + 6, color: WHITE, borderColor: this.cLine, borderWidth: 0.8 });
    page.drawImage(img, { x, y, width: size, height: size });
    const capW = this.bold.widthOfTextAtSize(caption, 7.5);
    page.drawText(caption, { x: x - 12 - capW, y: y + size / 2 + (ref ? 8 : 0), size: 7.5, font: this.bold, color: this.cPrimaryInk });
    if (ref) {
      const refW = this.font.widthOfTextAtSize(ref, 7);
      page.drawText(ref, { x: x - 12 - refW, y: y + size / 2 - 7, size: 7, font: this.font, color: MUTED });
    }
  }

  /** Signature lines with embedded signature PNG when present (contract §17). */
  async signatureImage(items: { caption: string; name?: string; img?: Buffer | Uint8Array }[]): Promise<void> {
    if (items.length === 0) return;
    const shown = items.slice(0, 3);
    const slotW = this.contentW / Math.min(3, Math.max(1, shown.length));
    const lineW = Math.min(170, slotW - 30);
    const imgs: (PDFImage | null)[] = [];
    for (const s of shown) {
      imgs.push(s.img && s.img.length > 0 ? await this.embed(s.img) : null);
    }
    const imgH = 34;
    this.ensure(imgH + 84);
    this.y -= imgH + 46;
    shown.forEach((s, i) => {
      const x = this.ML + i * slotW + 8;
      const img = imgs[i];
      const lineY = this.y;
      if (img) {
        const dim = img.scaleToFit(lineW - 6, imgH);
        this.page.drawImage(img, { x: x + (lineW - dim.width) / 2, y: lineY + 6, width: dim.width, height: dim.height });
        if (s.name) {
          this.page.drawText(pdfText(s.name).slice(0, 40), { x, y: lineY - 11, size: 8.5, font: this.bold, color: this.cInk });
        }
        this.page.drawText(pdfText(s.caption).slice(0, 44), { x, y: lineY - 20, size: 7.5, font: this.font, color: MUTED });
      } else {
        if (s.name) {
          this.page.drawText(pdfText(s.name).slice(0, 40), { x, y: lineY + 5, size: 8.5, font: this.bold, color: this.cInk });
        }
        this.page.drawText(pdfText(s.caption).slice(0, 44), { x, y: lineY - 11, size: 7.5, font: this.font, color: MUTED });
      }
      this.page.drawLine({ start: { x, y: lineY }, end: { x: x + lineW, y: lineY }, thickness: 0.9, color: MUTED });
    });
    this.y -= 20;
    this.recordInk(this.y, this.ML + (shown.length - 1) * slotW + 8 + lineW);
  }

  private wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const src = (text ?? "").replace(/\r\n?/g, "\n").trim();
    if (!src) return [];
    const lines: string[] = [];
    for (const raw of src.split("\n")) {
      const words = raw.split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        lines.push("");
        continue;
      }
      let cur = "";
      for (const w of words) {
        const attempt = cur ? `${cur} ${w}` : w;
        if (font.widthOfTextAtSize(attempt, size) <= maxWidth) {
          cur = attempt;
        } else {
          if (cur) lines.push(cur);
          if (font.widthOfTextAtSize(w, size) > maxWidth) {
            let chunk = "";
            for (const ch of w) {
              if (font.widthOfTextAtSize(chunk + ch, size) <= maxWidth) chunk += ch;
              else {
                lines.push(chunk);
                chunk = ch;
              }
            }
            cur = chunk;
          } else {
            cur = w;
          }
        }
      }
      if (cur) lines.push(cur);
    }
    return lines;
  }

  /** Finalize: footers with page numbers on every page (honouring the
   *  template footer configuration §20), validate, return bytes. */
  async build(): Promise<{ bytes: Uint8Array; pageCount: number }> {
    const n = this.pages.length;
    const stamp = `Generated ${fmtDateTime(new Date())}`;
    const custom = this.fc.customText?.trim();
    const leftLabel = custom ? pdfText(custom).slice(0, 90) : this.fc.contact ? pdfText(this.footerLabel) : "";
    const showPage = this.fc.pageNumber;
    const showStamp = this.fc.generatedDate;
    if (leftLabel || showPage || showStamp) {
      this.pages.forEach((p, i) => {
        const y = 34;
        p.drawLine({ start: { x: this.ML, y: y + 12 }, end: { x: this.PW - this.MR, y: y + 12 }, thickness: 0.6, color: this.cLine });
        if (leftLabel) p.drawText(leftLabel, { x: this.ML, y, size: 7.2, font: this.font, color: FAINT });
        if (showPage) {
          const pageLabel = `Page ${i + 1} of ${n}`;
          const pw = this.font.widthOfTextAtSize(pageLabel, 7.2);
          p.drawText(pageLabel, { x: (this.PW - pw) / 2, y, size: 7.2, font: this.font, color: MUTED });
        }
        if (showStamp) {
          const sw = this.font.widthOfTextAtSize(stamp, 7.2);
          p.drawText(stamp, { x: this.PW - this.MR - sw, y, size: 7.2, font: this.font, color: FAINT });
        }
      });
    }

    const bytes = await this.pdf.save();

    // §20 — validate before declaring success.
    const headerOk = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // "%PDF-"
    if (!headerOk) throw new PdfGenerationError("The document could not be generated.", "Generated bytes missing %PDF header");
    if (n < 1) throw new PdfGenerationError("The document could not be generated.", "Zero pages produced");
    if (bytes.length < 400) throw new PdfGenerationError("The document could not be generated.", `Suspiciously small output (${bytes.length} bytes)`);
    return { bytes, pageCount: n };
  }
}

/** Sanitize a filename for Content-Disposition (§23). */
export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\r\n\u0000-\u001F]/g, "")
    .replace(/[/\\?%*:|"<>\u0080-\uFFFF]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return cleaned || "document.pdf";
}
