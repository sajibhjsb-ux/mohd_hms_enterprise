// MOHD.HMS ENTERPRISE — Central PDF layout engine (§5 PDFService / §18 A4 design).
//
// ONE shared engine for every business document: brand header, page footers
// with "Page X of Y", word-wrapped text, multi-line tables with repeated
// headers across pages, totals blocks, key/value grids, signature lines and
// aspect-ratio-preserving images. Built on pdf-lib (MIT) — no license key,
// no native dependency, runs inside the existing Next.js business layer.
//
// Money/values MUST be pre-formatted through the central formatters in
// `@/lib/hms/format` (BND) before they reach this engine.

import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { fmtDateTime } from "@/lib/hms/format";

// Brand palette (matches the app's green primary, print-safe values).
const INK = rgb(0.13, 0.15, 0.17);
const MUTED = rgb(0.42, 0.45, 0.49);
const FAINT = rgb(0.62, 0.65, 0.68);
const LINE = rgb(0.84, 0.86, 0.88);
const ZEBRA = rgb(0.968, 0.976, 0.972);
const GREEN = rgb(0.082, 0.42, 0.235); // primary
const GREEN_SOFT = rgb(0.906, 0.949, 0.918);
const GREEN_INK = rgb(0.05, 0.3, 0.16);
const HEADER_BG = rgb(0.114, 0.396, 0.255);
const DANGER = rgb(0.7, 0.15, 0.15);
const WHITE = rgb(1, 1, 1);

// Characters safe for the standard WinAnsi fonts; everything else is replaced.
const WINANSI_SAFE = /^[\u0000-\u007F\u2018\u2019\u201A\u201C\u201D\u201E\u2013\u2014\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC]$/;

export function pdfText(input: string | null | undefined): string {
  const raw = String(input ?? "");
  let out = "";
  for (const ch of raw) {
    if (ch === "\t") {
      out += "  ";
    } else if (ch === "\n" || ch === "\r") {
      out += "\n";
    } else if (WINANSI_SAFE.test(ch)) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
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
  docTitle: string; // e.g. "WORK ORDER"
  docNumber: string; // e.g. WO-2026-0002
  docDateLabel: string; // e.g. "Issued 12 Feb 2026"
  meta?: [string, string][]; // extra right-column lines under the date
};

const A4W = 595.28;
const A4H = 841.89;
const MARGIN = 46;
const HEADER_RULE_Y = A4H - 92;

export class PdfDoc {
  private pdf!: PDFDocument;
  private font!: PDFFont;
  private bold!: PDFFont;
  private page!: PDFPage;
  private pages: PDFPage[] = [];
  private y = 0;
  private logo: PDFImage | null = null;
  private footerLabel = "MOHD.HMS ENTERPRISE";

  readonly W = A4W;
  readonly H = A4H;
  readonly M = MARGIN;
  readonly contentW = A4W - MARGIN * 2;

  private constructor() {}

  static async create(header: DocHeaderInfo, logoBytes?: Buffer | null): Promise<PdfDoc> {
    const d = new PdfDoc();
    d.pdf = await PDFDocument.create();
    d.pdf.setTitle(`${header.company} — ${header.docTitle} ${header.docNumber}`);
    d.pdf.setAuthor(header.company);
    d.pdf.setCreator("MOHD.HMS ENTERPRISE / FacilityPro");
    d.pdf.setProducer("FacilityPro PDF Service (pdf-lib)");
    d.font = await d.pdf.embedFont(StandardFonts.Helvetica);
    d.bold = await d.pdf.embedFont(StandardFonts.HelveticaBold);
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
    this.page = this.pdf.addPage([A4W, A4H]);
    this.pages.push(this.page);
    this.y = HEADER_RULE_Y - 24;
  }

  /** Brand header — drawn once per document on the first page (§17). */
  private drawHeader(h: DocHeaderInfo): void {
    const p = this.page;
    // Logo (aspect preserved, fitted to a 44pt box) or a monogram block.
    if (this.logo) {
      const dim = this.logo.scaleToFit(44, 44);
      p.drawImage(this.logo, { x: MARGIN, y: A4H - 58, width: dim.width, height: dim.height });
    } else {
      p.drawRectangle({ x: MARGIN, y: A4H - 62, width: 44, height: 44, color: GREEN });
      p.drawText("MH", { x: MARGIN + 10, y: A4H - 46, size: 16, font: this.bold, color: WHITE });
    }

    // Company block (left).
    let cy = A4H - 40;
    p.drawText(pdfText(h.company).slice(0, 42), { x: MARGIN + 54, y: cy, size: 12.5, font: this.bold, color: GREEN_INK });
    cy -= 13;
    for (const line of h.contactLines.slice(0, 3)) {
      const t = pdfText(line);
      if (!t) continue;
      p.drawText(t.slice(0, 70), { x: MARGIN + 54, y: cy, size: 7.6, font: this.font, color: MUTED });
      cy -= 10;
    }

    // Document identity (right-aligned).
    const right = (text: string, size: number, f: PDFFont, color = INK) => {
      const w = f.widthOfTextAtSize(text, size);
      p.drawText(text, { x: A4W - MARGIN - w, y: cy2, size, font: f, color });
    };
    let cy2 = A4H - 40;
    right(pdfText(h.docTitle).toUpperCase(), 14.5, this.bold, INK);
    cy2 -= 16;
    right(pdfText(h.docNumber), 10.5, this.bold, GREEN_INK);
    cy2 -= 13;
    right(pdfText(h.docDateLabel), 8.5, this.font, MUTED);
    for (const [k, v] of (h.meta ?? []).slice(0, 3)) {
      cy2 -= 11;
      right(pdfText(`${k}: ${v}`).slice(0, 46), 8.5, this.font, MUTED);
    }

    // Brand rule.
    p.drawRectangle({ x: MARGIN, y: HEADER_RULE_Y, width: A4W - MARGIN * 2, height: 2.4, color: GREEN });
  }

  private ensure(h: number): void {
    if (this.y - h < MARGIN + 30) this.addPage();
  }

  spacer(h = 10): void {
    this.y -= h;
  }

  divider(color = LINE): void {
    this.ensure(14);
    this.y -= 7;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4W - MARGIN, y: this.y }, thickness: 0.8, color });
    this.y -= 7;
  }

  /** Section heading with green square marker. */
  heading(text: string): void {
    const size = 10.5;
    this.ensure(26);
    this.y -= 18;
    this.page.drawRectangle({ x: MARGIN, y: this.y - 1.5, width: 7, height: 7, color: GREEN });
    this.page.drawText(pdfText(text), { x: MARGIN + 12, y: this.y, size, font: this.bold, color: INK });
    this.y -= 8;
  }

  /** Wrapped paragraph. */
  para(
    text: string,
    opts?: { size?: number; bold?: boolean; color?: "ink" | "muted" | "faint" | "green" | "danger"; gap?: number; indent?: number }
  ): void {
    const size = opts?.size ?? 9;
    const font = opts?.bold ? this.bold : this.font;
    const color =
      opts?.color === "muted" ? MUTED : opts?.color === "faint" ? FAINT : opts?.color === "green" ? GREEN_INK : opts?.color === "danger" ? DANGER : INK;
    const indent = opts?.indent ?? 0;
    const lines = this.wrap(pdfText(text), font, size, this.contentW - indent);
    for (const ln of lines) {
      this.ensure(size + 4);
      this.y -= size + 3.2;
      this.page.drawText(ln, { x: MARGIN + indent, y: this.y, size, font, color });
    }
    this.y -= opts?.gap ?? 2;
  }

  /** Label/value grid (2 columns by default) — values wrap. */
  kvGrid(pairs: [string, string][], opts?: { cols?: 1 | 2 | 3 }): void {
    const cols = opts?.cols ?? 2;
    const colW = this.contentW / cols;
    for (let i = 0; i < pairs.length; i += cols) {
      const rowPairs = pairs.slice(i, i + cols);
      let maxH = 0;
      const rendered = rowPairs.map(([label, value]) => {
        const valueLines = this.wrap(pdfText(value), this.font, 9, colW - 14);
        return { label, valueLines, h: 11 + valueLines.length * 11.5 + 7 };
      });
      for (const r of rendered) maxH = Math.max(maxH, r.h);
      this.ensure(maxH + 2);
      const yTop = this.y;
      rendered.forEach((r, idx) => {
        const x = MARGIN + idx * colW;
        this.page.drawText(pdfText(r.label).toUpperCase().slice(0, 32), { x, y: yTop - 8, size: 7.2, font: this.bold, color: FAINT });
        r.valueLines.forEach((ln, li) => {
          this.page.drawText(ln, { x, y: yTop - 18 - li * 11.5, size: 9, font: this.font, color: INK });
        });
      });
      this.y = yTop - maxH;
    }
  }

  /** Multi-line table with repeated headers across page breaks (§18).
   *  Cells may be plain strings or { text, bold } objects. */
  table(columns: TableCol[], rows: (string | TableCell)[][], opts?: { zebra?: boolean; emptyHint?: string }): void {
    const totalWeight = columns.reduce((s, c) => s + c.width, 0) || 1;
    const colX: number[] = [];
    const colW: number[] = [];
    let acc = MARGIN;
    for (const c of columns) {
      colX.push(acc);
      colW.push((c.width / totalWeight) * this.contentW);
      acc += colW[colW.length - 1];
    }

    const drawHeaderRow = () => {
      const hH = 19;
      this.page.drawRectangle({ x: MARGIN, y: this.y - hH, width: this.contentW, height: hH, color: HEADER_BG });
      columns.forEach((c, i) => {
        const label = pdfText(c.header);
        const w = this.bold.widthOfTextAtSize(label, 8);
        const x = c.align === "right" ? colX[i] + colW[i] - w - 6 : c.align === "center" ? colX[i] + (colW[i] - w) / 2 : colX[i] + 6;
        this.page.drawText(label, { x, y: this.y - hH + 6, size: 8, font: this.bold, color: WHITE });
      });
      this.y -= hH;
    };

    this.ensure(40);
    drawHeaderRow();

    if (rows.length === 0 && opts?.emptyHint) {
      this.ensure(20);
      this.y -= 16;
      this.page.drawText(pdfText(opts.emptyHint), { x: MARGIN + 6, y: this.y, size: 8.5, font: this.font, color: FAINT });
      return;
    }

    rows.forEach((row, ri) => {
      // Pre-wrap all cells to measure the row height.
      const cells = row.map((cell, i) => {
        const c = columns[i];
        const bold = typeof cell === "object" && cell.bold;
        const text = pdfText(typeof cell === "string" ? cell : cell.text);
        const font = bold ? this.bold : this.font;
        return { text, font, lines: this.wrap(text, font, 8.5, colW[i] - 12) };
      });
      const maxLines = Math.max(1, ...cells.map((c) => c.lines.length));
      const rowH = maxLines * 11 + 7;

      if (this.y - rowH < MARGIN + 26) {
        this.addPage();
        drawHeaderRow(); // repeated header on every continued page
      }

      if (opts?.zebra !== false && ri % 2 === 1) {
        this.page.drawRectangle({ x: MARGIN, y: this.y - rowH, width: this.contentW, height: rowH, color: ZEBRA });
      }

      cells.forEach((cell, i) => {
        const c = columns[i];
        cell.lines.forEach((ln, li) => {
          const lineW = cell.font.widthOfTextAtSize(ln, 8.5);
          const x = c.align === "right" ? colX[i] + colW[i] - lineW - 6 : c.align === "center" ? colX[i] + (colW[i] - lineW) / 2 : colX[i] + 6;
          this.page.drawText(ln, { x, y: this.y - 11 - li * 11, size: 8.5, font: cell.font, color: INK });
        });
      });
      this.y -= rowH;
      // faint row separator
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4W - MARGIN, y: this.y }, thickness: 0.4, color: LINE });
    });
    this.y -= 4;
  }

  /** Right-aligned totals block; the last row is the emphasized grand total. */
  totals(rows: [string, string][], opts?: { accent?: boolean }): void {
    const blockW = 250;
    const x0 = A4W - MARGIN - blockW;
    this.ensure(rows.length * 16 + 14);
    this.y -= 4;
    rows.forEach(([label, value], i) => {
      const isLast = i === rows.length - 1;
      if (isLast && opts?.accent !== false) {
        this.page.drawRectangle({ x: x0 - 8, y: this.y - 16, width: blockW + 8, height: 20, color: GREEN_SOFT });
      }
      const size = isLast ? 10 : 9;
      const f = isLast ? this.bold : this.font;
      const vw = f.widthOfTextAtSize(pdfText(value), size);
      this.page.drawText(pdfText(label), { x: x0, y: this.y - 12, size, font: f, color: isLast ? GREEN_INK : MUTED });
      this.page.drawText(pdfText(value), { x: x0 + blockW - vw, y: this.y - 12, size, font: f, color: isLast ? GREEN_INK : INK });
      this.y -= isLast ? 22 : 16;
    });
  }

  /** Full-width single line label/value banner (status lines). */
  banner(text: string, tone: "green" | "danger" | "muted" = "green"): void {
    this.ensure(24);
    this.y -= 6;
    const h = 19;
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - h + 4,
      width: this.contentW,
      height: h,
      color: tone === "green" ? GREEN_SOFT : tone === "danger" ? rgb(0.96, 0.92, 0.92) : rgb(0.95, 0.95, 0.955),
    });
    this.page.drawText(pdfText(text), {
      x: MARGIN + 8,
      y: this.y - 8.5 + 4,
      size: 8.8,
      font: this.bold,
      color: tone === "green" ? GREEN_INK : tone === "danger" ? DANGER : MUTED,
    });
    this.y -= h + 8;
  }

  /** Signature lines (§18) — up to 3 side-by-side. */
  signatures(items: { caption: string; name?: string }[]): void {
    if (items.length === 0) return;
    this.ensure(84);
    this.y -= 46;
    const slotW = this.contentW / Math.min(3, Math.max(1, items.length));
    items.slice(0, 3).forEach((s, i) => {
      const x = MARGIN + i * slotW + 8;
      const lineW = Math.min(170, slotW - 30);
      this.page.drawLine({ start: { x, y: this.y }, end: { x: x + lineW, y: this.y }, thickness: 0.9, color: MUTED });
      if (s.name) {
        this.page.drawText(pdfText(s.name).slice(0, 40), { x, y: this.y + 5, size: 8.5, font: this.bold, color: INK });
      }
      this.page.drawText(pdfText(s.caption).slice(0, 44), { x, y: this.y - 11, size: 7.5, font: this.font, color: MUTED });
    });
    this.y -= 18;
  }

  /** Notes/terms block rendered as a titled section. */
  notesBlock(title: string, body: string): void {
    if (!body?.trim()) return;
    this.heading(title);
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
    this.page.drawImage(img, { x: MARGIN, y: this.y, width: dim.width, height: dim.height });
    if (opts.caption) {
      this.y -= 12;
      this.page.drawText(pdfText(opts.caption).slice(0, 90), { x: MARGIN, y: this.y, size: 7.5, font: this.font, color: MUTED });
    }
    this.y -= 6;
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

  /**
   * 3×3 photo grid pages. Each inner array is ONE pre-chunked page of ≤9 cells
   * (the renderer guarantees categories are never mixed on a page). Images are
   * contain-fit (never distorted) with number + caption under each cell; a
   * missing file renders a placeholder cell instead.
   */
  async photoGrid(pages: { caption: string; number: string; bytes: Buffer | Uint8Array | null }[][]): Promise<void> {
    const usableTop = HEADER_RULE_Y - 24;
    for (const cells of pages) {
      if (!cells || cells.length === 0) continue;
      // Continue on the current page only when it is still effectively fresh
      // (a section heading was just drawn); otherwise start a dedicated page.
      if (this.y < usableTop - 60) this.addPage();
      const gridTop = this.y;
      const gridBottom = MARGIN + 30;
      const cellW = this.contentW / 3;
      const cellH = (gridTop - gridBottom) / 3;
      const imgH = cellH - 34;
      const imgW = cellW - 12;

      for (let i = 0; i < Math.min(9, cells.length); i++) {
        const cell = cells[i];
        const col = i % 3;
        const row = Math.floor(i / 3);
        const x = MARGIN + col * cellW;
        const yTop = gridTop - row * cellH;

        this.page.drawRectangle({
          x: x + 1,
          y: yTop - cellH + 2,
          width: cellW - 2,
          height: cellH - 4,
          borderColor: LINE,
          borderWidth: 0.7,
        });

        let drew = false;
        if (cell.bytes && cell.bytes.length > 0) {
          const img = await this.embed(cell.bytes);
          if (img) {
            const dim = img.scaleToFit(imgW, imgH);
            const ix = x + (cellW - dim.width) / 2;
            const iy = yTop - 8 - imgH + (imgH - dim.height) / 2;
            this.page.drawImage(img, { x: ix, y: iy, width: dim.width, height: dim.height });
            drew = true;
          }
        }
        if (!drew) {
          this.page.drawRectangle({ x: x + 7, y: yTop - 8 - imgH, width: cellW - 14, height: imgH, color: ZEBRA });
          const t = "Photo file unavailable";
          const tw = this.font.widthOfTextAtSize(t, 8);
          this.page.drawText(t, { x: x + (cellW - tw) / 2, y: yTop - 8 - imgH / 2 + 3, size: 8, font: this.font, color: FAINT });
        }

        // Number (bold) + caption in the strip under the cell.
        const capY = yTop - cellH + 14;
        this.page.drawText(pdfText(cell.number).slice(0, 12), { x: x + 6, y: capY, size: 8, font: this.bold, color: GREEN_INK });
        const numW = this.bold.widthOfTextAtSize(pdfText(cell.number).slice(0, 12), 8) + 6;
        const caption = pdfText(cell.caption || "—");
        const maxCw = cellW - numW - 14;
        let line = caption.slice(0, 60);
        while (line.length > 1 && this.font.widthOfTextAtSize(line, 7.5) > maxCw) line = line.slice(0, -1);
        if (caption.length > line.length) line = line.slice(0, -1) + "…";
        this.page.drawText(line, { x: x + 6 + numW, y: capY, size: 7.5, font: this.font, color: MUTED });
      }
      this.y = gridTop - 3 * cellH - 6;
    }
  }

  /** Embed a QR PNG at the footer area of the FIRST page (contract §17). */
  async qr(png: Buffer | Uint8Array, opts?: { caption?: string }): Promise<void> {
    if (!png || png.length === 0) return;
    const img = await this.embed(png);
    if (!img) return;
    const size = 54;
    const page = this.pages[0];
    const x = A4W - MARGIN - size;
    const y = 50;
    page.drawRectangle({ x: x - 3, y: y - 3, width: size + 6, height: size + 6, color: WHITE, borderColor: LINE, borderWidth: 0.6 });
    page.drawImage(img, { x, y, width: size, height: size });
    if (opts?.caption) {
      const caption = pdfText(opts.caption).slice(0, 44);
      const tw = this.font.widthOfTextAtSize(caption, 7);
      page.drawText(caption, { x: x - 8 - tw, y: y + 22, size: 7, font: this.font, color: FAINT });
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
      const x = MARGIN + i * slotW + 8;
      const img = imgs[i];
      const lineY = this.y;
      if (img) {
        const dim = img.scaleToFit(lineW - 6, imgH);
        this.page.drawImage(img, { x: x + (lineW - dim.width) / 2, y: lineY + 6, width: dim.width, height: dim.height });
        if (s.name) {
          this.page.drawText(pdfText(s.name).slice(0, 40), { x, y: lineY - 11, size: 8.5, font: this.bold, color: INK });
        }
        this.page.drawText(pdfText(s.caption).slice(0, 44), { x, y: lineY - 20, size: 7.5, font: this.font, color: MUTED });
      } else {
        if (s.name) {
          this.page.drawText(pdfText(s.name).slice(0, 40), { x, y: lineY + 5, size: 8.5, font: this.bold, color: INK });
        }
        this.page.drawText(pdfText(s.caption).slice(0, 44), { x, y: lineY - 11, size: 7.5, font: this.font, color: MUTED });
      }
      this.page.drawLine({ start: { x, y: lineY }, end: { x: x + lineW, y: lineY }, thickness: 0.9, color: MUTED });
    });
    this.y -= 20;
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

  /** Finalize: footers with page numbers on every page, validate, return bytes. */
  async build(): Promise<{ bytes: Uint8Array; pageCount: number }> {
    const n = this.pages.length;
    const stamp = `Generated ${fmtDateTime(new Date())}`;
    this.pages.forEach((p, i) => {
      const y = 34;
      p.drawLine({ start: { x: MARGIN, y: y + 12 }, end: { x: A4W - MARGIN, y: y + 12 }, thickness: 0.6, color: LINE });
      p.drawText(pdfText(this.footerLabel), { x: MARGIN, y, size: 7.2, font: this.font, color: FAINT });
      const pageLabel = `Page ${i + 1} of ${n}`;
      const pw = this.font.widthOfTextAtSize(pageLabel, 7.2);
      p.drawText(pageLabel, { x: (A4W - pw) / 2, y, size: 7.2, font: this.font, color: MUTED });
      const sw = this.font.widthOfTextAtSize(stamp, 7.2);
      p.drawText(stamp, { x: A4W - MARGIN - sw, y, size: 7.2, font: this.font, color: FAINT });
    });

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
