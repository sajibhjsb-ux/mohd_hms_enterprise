// MOHD.HMS ENTERPRISE — Letters: deterministic template renderer (§46).
//
// The TEMPLATE controls structure; data + AI only fill content slots. This
// module:
//   1. resolves {{PLACEHOLDERS}} against letter data + system values,
//   2. renders the initial body from the template skeleton (the {{BODY}} slot),
//   3. builds the single rendered structure (LetterPreviewModel) used by BOTH
//      the HTML preview and the PDF builder — one source of truth (§26).
//
// Unknown/unfilled placeholders resolve to "" and empty lines are dropped, so
// no raw {{...}} can ever leak into an issued letter.

import "server-only";
import type { Branding } from "@/lib/hms/pdf/branding";
import { fmtDate } from "@/lib/hms/format";
import { letterTypeLabel } from "./shared";
import type { LetterPreviewModel, TemplateField } from "./shared";
import type { TemplateContentSnapshot } from "./server";

// ── Placeholder resolution ──

/** Replace every {{KEY}} with values[KEY] ?? "". Blank values collapse to "". */
export function resolvePlaceholders(text: string, values: Record<string, string>): string {
  return (text ?? "").replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key: string) => (values[key] ?? "").trim());
}

/**
 * System values available to every template (§6) — company identity comes from
 * the existing Company Settings via the shared branding reader (§19), the
 * reference number and letter date are server-authoritative (§17/§18).
 */
export function systemValues(opts: {
  letterNumber: string;
  letterDate: Date;
  branding: Branding;
  website?: string;
  salutation: string;
  signatoryName: string;
  signatoryPosition: string;
  body: string;
}): Record<string, string> {
  const { branding } = opts;
  return {
    LETTER_DATE: fmtDate(opts.letterDate),
    REFERENCE_NO: opts.letterNumber,
    COMPANY_NAME: branding.company,
    COMPANY_ADDRESS: branding.address,
    COMPANY_PHONE: branding.phone,
    COMPANY_EMAIL: branding.email,
    COMPANY_WEBSITE: opts.website ?? "",
    SALUTATION: opts.salutation,
    SIGNATORY_NAME: opts.signatoryName,
    SIGNATORY_POSITION: opts.signatoryPosition,
    BODY: opts.body,
  };
}

/** Default salutation: address the recipient by name, else Sir/Madam. */
export function defaultSalutation(data: Record<string, string>): string {
  const name = (data["RECIPIENT_NAME"] ?? "").trim();
  return name ? `Dear ${name},` : "Dear Sir/Madam,";
}

/**
 * Initial body from the template skeleton: resolve every placeholder, with the
 * {{BODY}} slot initially EMPTY (the user or the AI fills it next). A template
 * that is just "{{BODY}}" starts blank; otherwise the static wrapper text
 * renders immediately so the draft looks like the template from creation.
 */
export function renderInitialBody(
  snapshot: TemplateContentSnapshot,
  values: Record<string, string>,
  existingBody: string
): string {
  const withBody: Record<string, string> = { ...values, BODY: existingBody };
  return resolvePlaceholders(snapshot.bodyTemplate, withBody)
    .split(/\n{3,}/)
    .join("\n\n")
    .trim();
}

// ── Rendered structure (HTML preview + PDF share this) ──

function splitLines(value: string | undefined): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type RenderInput = {
  letterId: string;
  letterNumber: string;
  letterType: string;
  letterDate: Date;
  status: string;
  subject: string;
  body: string;
  salutation: string;
  closing: string;
  data: Record<string, string>;
  signatoryName: string;
  signatoryPosition: string;
  hasSignatureImage: boolean;
  enclosures: string[];
  branding: Branding;
  website?: string;
};

/** Build the canonical rendered letter (§26) from authoritative stored data. */
export function renderLetterModel(input: RenderInput): LetterPreviewModel {
  const { data, branding } = input;

  // Recipient block — name, position, organization, then each address line.
  const recipientLines = [
    data["RECIPIENT_NAME"] ?? "",
    data["AUTHORIZED_PERSON"] ?? "", // LOA: the letter may address the authorized person's org
    data["RECIPIENT_POSITION"] ?? "",
    data["RECIPIENT_COMPANY"] ?? "",
    ...splitLines(data["RECIPIENT_ADDRESS"]),
  ]
    .map((s) => s.trim())
    .filter(Boolean);

  // Values for the subject line (system + data placeholders).
  const values = systemValues({
    letterNumber: input.letterNumber,
    letterDate: input.letterDate,
    branding,
    website: input.website,
    salutation: "",
    signatoryName: input.signatoryName,
    signatoryPosition: input.signatoryPosition,
    body: "",
  });

  return {
    company: {
      name: branding.company,
      addressLines: branding.contactLines,
      phone: branding.phone,
      email: branding.email,
      website: "",
    },
    typeLabel: letterTypeLabel(input.letterType),
    referenceNo: input.letterNumber,
    letterDate: fmtDate(input.letterDate),
    recipientLines,
    subject: resolvePlaceholders(input.subject, { ...values, ...data }).trim(),
    salutation: input.salutation || defaultSalutation(data),
    // A paragraph = text between blank lines; single newlines inside a
    // paragraph are preserved (HTML renders <br>, the PDF engine's word-wrap
    // handles them natively).
    paragraphs: input.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
    closing: input.closing || "Yours faithfully,",
    signatory: {
      name: input.signatoryName,
      position: input.signatoryPosition,
      hasSignatureImage: input.hasSignatureImage,
      signatureUrl: `/api/v1/hr/letters/${input.letterId}/signature`,
    },
    enclosures: input.enclosures,
    status: input.status,
  };
}

/** Fields available in template placeholder docs (for editor hint UI). */
export function fieldKeys(fields: TemplateField[]): string[] {
  return fields.map((f) => f.key);
}
