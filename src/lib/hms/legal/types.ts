// MOHD.HMS ENTERPRISE — shared legal types (client-safe, no data).
// Kept separate from lib/hms/legal/legal.ts (server-only) so client components
// can import the public shapes without pulling server code.

export type LegalKind = "TERMS" | "PRIVACY";

export type LegalSection = { id: string; title: string; body: string };

/** Shape served to ALL readers (public page, portal, consent gate). */
export type PublicLegalDoc = {
  /** Document id (public, stable reference — also used in audit records). */
  id: string;
  kind: LegalKind;
  version: string;
  /** ISO date or null — null means the company has not approved an effective
   *  date yet and the UI renders it as pending approval. */
  effectiveDate: string | null;
  publishedAt: string | null;
  changeSummary: string;
  sections: LegalSection[];
};

/** Company identity for legal pages (whitelisted fields only). */
export type CompanyIdentity = {
  name: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  country: string;
};

/** Terms acceptance state attached to the session payload (auth contract). */
export type TermsStatusShape = {
  version: string | null;
  effectiveDate: string | null;
  publishedAt: string | null;
  changeSummary: string | null;
  /** Version the user last accepted (null = never accepted). */
  acceptedVersion: string | null;
  /** True when the portal must request acceptance before customer features. */
  requiresAcceptance: boolean;
};

/** API path for a legal kind's public document. */
export function legalApiPath(kind: LegalKind): string {
  return kind === "TERMS" ? "/api/v1/legal/terms" : "/api/v1/legal/privacy";
}

/** Human page title for a legal kind. */
export function legalTitle(kind: LegalKind): string {
  return kind === "TERMS" ? "Terms & Conditions" : "Privacy Policy";
}
