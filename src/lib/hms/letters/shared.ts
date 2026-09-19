// MOHD.HMS ENTERPRISE — HR Letters domain shared module (client-safe).
//
// Letter type catalog, template field model and DTO shapes shared by the API
// layer, the server services and the UI. No server-only imports here — this
// file is imported by client components.

// ── Letter types (§4) ──

export const LETTER_TYPES = [
  "LOU",
  "LOA",
  "SUBMISSION",
  "CLARIFICATION",
  "APPOINTMENT",
  "CONFIRMATION",
  "WARNING",
  "EMPLOYMENT",
  "VERIFICATION",
  "TRAINING",
  "REFERENCE",
  "GENERAL",
  "CUSTOM",
] as const;
export type LetterType = (typeof LETTER_TYPES)[number];

export const LETTER_TYPE_META: Record<LetterType, { label: string; description: string; sensitive: boolean }> = {
  LOU: { label: "Letter of Undertaking", description: "Formal undertaking by the company or an individual", sensitive: true },
  LOA: { label: "Letter of Authorization", description: "Authorize a person to act on the company's behalf", sensitive: true },
  SUBMISSION: { label: "Submission Letter", description: "Submit documents/tenders to a client or authority", sensitive: false },
  CLARIFICATION: { label: "Clarification Letter", description: "Clarify a matter with a client or authority", sensitive: false },
  APPOINTMENT: { label: "Appointment Letter", description: "Appoint a new employee to a position", sensitive: false },
  CONFIRMATION: { label: "Confirmation Letter", description: "Confirm an employee after probation", sensitive: false },
  WARNING: { label: "Warning Letter", description: "Formal disciplinary warning", sensitive: true },
  EMPLOYMENT: { label: "Employment Letter", description: "Confirm a person is employed by the company", sensitive: false },
  VERIFICATION: { label: "Salary / Employment Verification", description: "Verify employment and salary details", sensitive: true },
  TRAINING: { label: "Training / Internship Letter", description: "Training or internship placement letter", sensitive: false },
  REFERENCE: { label: "Reference Letter", description: "Professional reference for an employee", sensitive: false },
  GENERAL: { label: "General Official Letter", description: "Any other official company letter", sensitive: false },
  CUSTOM: { label: "Custom Letter", description: "Custom letter template with user-defined fields", sensitive: false },
};

export function letterTypeLabel(type: string): string {
  return LETTER_TYPE_META[type as LetterType]?.label ?? type;
}

export function letterTypeSensitive(type: string): boolean {
  return LETTER_TYPE_META[type as LetterType]?.sensitive ?? false;
}

// ── Template field model (§7) ──

export const TEMPLATE_FIELD_TYPES = [
  "text",
  "textarea",
  "date",
  "number",
  "select",
  "employee",
  "customer",
  "project",
  "quotation",
  "workorder",
] as const;
export type TemplateFieldType = (typeof TEMPLATE_FIELD_TYPES)[number];

export type TemplateField = {
  key: string; // placeholder key, e.g. RECIPIENT_NAME (rendered as {{RECIPIENT_NAME}})
  label: string;
  type: TemplateFieldType;
  required?: boolean;
  options?: string[];
  hint?: string;
  /** Include this field's value in the AI drafting context (§7/§41). */
  ai?: boolean;
};

/** System-provided placeholders rendered automatically (never asked in forms). */
export const SYSTEM_PLACEHOLDERS = [
  "LETTER_DATE",
  "REFERENCE_NO",
  "COMPANY_NAME",
  "COMPANY_ADDRESS",
  "COMPANY_PHONE",
  "COMPANY_EMAIL",
  "COMPANY_WEBSITE",
  "SALUTATION",
  "BODY",
  "SIGNATORY_NAME",
  "SIGNATORY_POSITION",
] as const;

export function validateFieldKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]{1,39}$/.test(key);
}

// ── Template DTO ──

export type LetterTemplateDto = {
  id: string;
  code: string;
  name: string;
  letterType: string;
  description: string;
  department: string;
  version: number;
  status: string;
  language: string;
  pageSize: string;
  isDefault: boolean;
  effectiveDate: string | null;
  aiInstructions: string;
  subjectHint: string;
  bodyTemplate: string;
  closingTemplate: string;
  fields: TemplateField[];
  createdAt: string;
  updatedAt: string;
  lettersCount?: number;
};

// ── Letter DTOs ──

export type LetterAttachmentDto = {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
};

export type LetterEventDto = {
  id: string;
  action: string;
  detail: string;
  actorName: string;
  createdAt: string;
};

export type LetterListItemDto = {
  id: string;
  letterNumber: string;
  letterType: string;
  status: string;
  subject: string;
  recipientName: string;
  recipientCompany: string;
  employeeName: string | null;
  department: string;
  letterDate: string;
  contentSource: string;
  createdAt: string;
  createdByName: string;
  approvedByName: string;
  finalizedAt: string | null;
  hasPdf: boolean;
};

export type LetterDetailDto = {
  id: string;
  letterNumber: string;
  letterType: string;
  status: string;
  templateId: string | null;
  templateCode: string;
  templateName: string;
  templateVersion: number;
  letterDate: string;
  data: Record<string, string>;
  bodySlot: string;
  subject: string;
  body: string;
  salutation: string;
  closing: string;
  contentSource: string;
  recipientName: string;
  recipientCompany: string;
  employeeId: string | null;
  employeeName: string | null;
  signatoryName: string;
  signatoryPosition: string;
  hasSignatureImage: boolean;
  hasPdf: boolean;
  finalizedAt: string | null;
  approvedByName: string;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  createdByName: string;
  fields: TemplateField[];
  attachments: LetterAttachmentDto[];
  events: LetterEventDto[];
};

// ── Rendered letter structure (§26 — single source for HTML preview + PDF) ──

export type LetterPreviewModel = {
  company: { name: string; addressLines: string[]; phone: string; email: string; website: string };
  typeLabel: string;
  referenceNo: string;
  letterDate: string;
  recipientLines: string[];
  subject: string;
  salutation: string;
  paragraphs: string[];
  closing: string;
  signatory: { name: string; position: string; hasSignatureImage: boolean; signatureUrl: string };
  enclosures: string[];
  status: string;
};

// ── AI actions (§14) ──

export const LETTER_AI_ACTIONS = [
  "generate",
  "regenerate",
  "shorten",
  "expand",
  "formal",
  "concise",
  "grammar",
] as const;
export type LetterAiAction = (typeof LETTER_AI_ACTIONS)[number];

export const LETTER_AI_ACTION_LABEL: Record<LetterAiAction, string> = {
  generate: "Generate with AI",
  regenerate: "Regenerate",
  shorten: "Make Shorter",
  expand: "Expand",
  formal: "Make More Formal",
  concise: "Make More Concise",
  grammar: "Fix Grammar",
};

// ── Workflow actions (§16) ──

export const LETTER_WORKFLOW_ACTIONS = ["submit", "approve", "reject", "finalize", "send", "share", "archive", "reopen"] as const;
export type LetterWorkflowAction = (typeof LETTER_WORKFLOW_ACTIONS)[number];

// ── Template version DTO ──

export type LetterTemplateVersionDto = {
  id: string;
  version: number;
  createdByName: string;
  createdAt: string;
};

// ── Placeholder extraction (shared: template editor shows unresolved keys) ──

export function extractPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) out.add(m[1]);
  return [...out];
}

// ── Storage layout (§23) — also used by QA scripts ──

export function letterObjectPrefix(letterId: string, letterType: string, createdAt: Date): string {
  return `letters/${createdAt.getFullYear()}/${letterType}/${letterId}`;
}
