// MOHD.HMS ENTERPRISE — Letters: final PDF builder (§20/§21/§37).
//
// Reuses the CENTRAL PdfDoc engine (brand header with the official letterhead,
// A4, footers with Page X of Y) — no second PDF engine. The letter renders from
// the SAME rendered structure as the HTML preview (§26).

import "server-only";
import { db } from "@/lib/db";
import { getBranding } from "@/lib/hms/pdf/branding";
import { PdfDoc, safeFilename, pdfText } from "@/lib/hms/pdf/engine";
import { letterTypeLabel } from "./shared";
import { renderLetterModel } from "./renderer";
import { storage } from "@/lib/hms/storage";

export type LetterPdfData = {
  id: string;
  letterNumber: string;
  letterType: string;
  letterDate: Date;
  status: string;
  subject: string;
  body: string;
  salutation: string;
  closing: string;
  dataJson: string;
  signatoryName: string;
  signatoryPosition: string;
  signatorySignatureKey: string;
};

/** Signature image bytes (MinIO) — null when absent/unreadable. */
async function signatureImageBytes(key: string): Promise<Buffer | null> {
  if (!key) return null;
  try {
    const obj = await storage.get(key);
    return obj?.buffer ?? null;
  } catch {
    return null;
  }
}

/** Build the letter PDF bytes + suggested filename from authoritative data. */
export async function buildLetterPdf(letter: LetterPdfData): Promise<{ bytes: Uint8Array; filename: string }> {
  const branding = await getBranding();
  const website = await db.setting
    .findUnique({ where: { key: "public_url" }, select: { value: true } })
    .then((r) => r?.value ?? "")
    .catch(() => "");

  const enclosures = await db.letterAttachment
    .findMany({ where: { letterId: letter.id }, orderBy: { createdAt: "asc" }, select: { name: true } })
    .catch(() => []);

  const model = renderLetterModel({
    letterId: letter.id,
    letterNumber: letter.letterNumber,
    letterType: letter.letterType,
    letterDate: letter.letterDate,
    status: letter.status,
    subject: letter.subject,
    body: letter.body,
    salutation: letter.salutation,
    closing: letter.closing,
    data: safeData(letter.dataJson),
    signatoryName: letter.signatoryName,
    signatoryPosition: letter.signatoryPosition,
    hasSignatureImage: Boolean(letter.signatorySignatureKey),
    enclosures: enclosures.map((e) => e.name),
    branding,
    website,
  });

  const doc = await PdfDoc.create(
    {
      company: branding.company,
      contactLines: branding.contactLines,
      docTitle: pdfText(model.typeLabel).toUpperCase(),
      docNumber: letter.letterNumber,
      docDateLabel: `Dated ${model.letterDate}`,
    },
    branding.logoBytes
  );

  // ── Letter body (classic official-letter layout) ─────────────────────────

  if (model.recipientLines.length > 0) {
    doc.spacer(4);
    for (const line of model.recipientLines) doc.para(line, { size: 10, gap: 1 });
    doc.spacer(10);
  }

  if (model.subject) {
    doc.para(`Subject: ${model.subject}`, { size: 10, bold: true, gap: 10 });
  }

  doc.para(model.salutation, { size: 10, gap: 8 });

  for (const p of model.paragraphs) {
    doc.para(p, { size: 9.6, gap: 7 });
  }
  if (model.paragraphs.length === 0) {
    doc.para("(Letter body is empty — complete the draft before finalizing.)", { size: 9.6, color: "danger" });
  }

  doc.spacer(8);
  doc.para(model.closing, { size: 10, gap: 4 });

  // Signature block — official signature image when provided (§22), otherwise
  // a signature line above the printed name.
  const sigBytes = await signatureImageBytes(letter.signatorySignatureKey);
  await doc.signatureImage([
    {
      caption: model.signatory.position || model.signatory.name || "Authorised Signatory",
      name: model.signatory.name,
      img: sigBytes ?? undefined,
    },
  ]);

  // Enclosures (§33) — references only; files live in object storage.
  if (model.enclosures.length > 0) {
    doc.spacer(4);
    doc.para(`Encl: ${model.enclosures.join("; ")}`, { size: 8.4, color: "muted" });
  }

  const { bytes } = await doc.build();
  return { bytes, filename: safeFilename(`MOHD-HMS-${model.typeLabel.replace(/\s+/g, "")}-${letter.letterNumber.replace(/\//g, "-")}.pdf`) };
}

function safeData(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Storage key for the immutable final PDF (§23). */
export function letterPdfKey(letter: { id: string; letterType: string; createdAt: Date }): string {
  return `letters/${letter.createdAt.getFullYear()}/${letter.letterType}/${letter.id}/final.pdf`;
}

export { letterTypeLabel };
