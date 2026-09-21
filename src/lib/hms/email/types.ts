// MOHD.HMS ENTERPRISE — Email system types (shared vocabulary).
// ONE centralized email system (spec: Email Automation + Email Configuration):
//   BUSINESS EVENT → OUTBOX (DomainEvent) → EMAIL AUTOMATION → TEMPLATE →
//   DATA RESOLUTION → ATTACHMENT RESOLUTION (MinIO) → QUEUE (EmailLog) →
//   EMAIL WORKER → SMTP (Mailflare endpoint in production) → EMAIL LOG.

import "server-only";

// ─── Delivery statuses (§19/§54 — honest states; SMTP accepted ≠ delivered) ──
export const EMAIL_STATUSES = [
  "QUEUED",
  "PROCESSING",
  "SMTP_ACCEPTED",
  "SENT",
  "FAILED",
  "DEAD_LETTER",
  "CANCELED",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** Terminal states (no further worker processing). */
export const EMAIL_TERMINAL_STATUSES: readonly string[] = ["SENT", "CANCELED", "DEAD_LETTER"];

// ─── Error classes (§36 — permanent errors are never retried indefinitely) ──
export const EMAIL_ERROR_CLASSES = [
  "TEMPORARY", // 4xx SMTP — retry
  "PERMANENT", // 5xx permanent — no retry
  "AUTHENTICATION",
  "RECIPIENT",
  "RATE_LIMIT",
  "NETWORK", // DNS / connect / timeout — retry
  "PROVIDER",
  "CONFIG", // SMTP not configured — stays queued, no attempt burn
] as const;
export type EmailErrorClass = (typeof EMAIL_ERROR_CLASSES)[number];

// ─── Categories (§7 — only categories the application actually needs) ───────
export const EMAIL_CATEGORIES = [
  "AUTHENTICATION",
  "CUSTOMER",
  "COMPLAINTS",
  "WORK_ORDERS",
  "QUOTATIONS",
  "INVOICES",
  "PAYMENTS",
  "PURCHASES",
  "HR",
  "IRMS",
  "LETTERS",
  "REPORTS",
  "SYSTEM",
] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

/**
 * Non-essential categories a user may opt out of (§40/§41). Security-critical
 * mail (OTP, security alerts) NEVER honors opt-out.
 */
export const EMAIL_OPTIONAL_CATEGORIES: readonly string[] = ["REPORTS", "SYSTEM"];

// ─── Recipient rules (§23 — resolved from authorized application data) ──────
export type RecipientRule =
  | { kind: "CUSTOMER" } // customer.email of the event's customer
  | { kind: "RELATED_USER" } // the user tied to the event payload (technician, portal user…)
  | { kind: "ROLE"; value: string } // every ACTIVE user with the role
  | { kind: "MODULE_MAILBOX"; value: string } // company_email_{sales|service|finance|hr|procurement|inspection|info}
  | { kind: "FIXED"; value: string }; // explicit admin-configured mailbox

// ─── Conditions (§34 — controlled schema, evaluated server-side) ────────────
export type EmailCondition = {
  /** Dotted path into the resolved event data (e.g. "status", "balanceCents"). */
  field: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "nin" | "exists";
  /** Comparison value (string/number/bool; arrays for in/nin as comma string). */
  value?: string | number | boolean;
};

// ─── Attachments (§21/§22 — resolved via authorized entities, MinIO only) ───
export type AttachmentKind =
  | "INVOICE_PDF"
  | "QUOTATION_PDF"
  | "WO_PDF"
  | "INSPECTION_PDF"
  | "LETTER_PDF"
  | "PAYMENT_RECEIPT_PDF"
  // Email client attachment — uploaded through the authenticated
  // /api/v1/email/client/attachments endpoint, which generates the MinIO key
  // server-side under the uploader's own `mail/{userId}/` prefix. The spec
  // carries that validated reference; arbitrary client keys are never accepted.
  | "MAIL_FILE";
export type AttachmentSpec = { kind: AttachmentKind };
// Mail-file specs additionally carry the validated MinIO reference details.
export type MailFileSpec = AttachmentSpec & { kind: "MAIL_FILE"; key: string; filename: string; contentType?: string };

export type ResolvedAttachment = {
  kind: AttachmentKind;
  filename: string;
  buffer: Buffer;
  contentType: string;
  /** Immutable reference stored in the log — never a raw user-supplied key. */
  ref: string;
};

// ─── Sender profile (§25 — configurable per module, never arbitrary) ────────
export type SenderIdentity = {
  fromName: string;
  fromEmail: string;
  replyTo: string;
};

// ─── Render result ──────────────────────────────────────────────────────────
export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  warnings: string[];
  usedVariables: string[];
};

export type EmailConfigSafe = {
  provider: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  smtpUser: string;
  /** Whether an SMTP password is stored (the value itself is never returned). */
  hasPassword: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  timeoutMs: number;
  testRecipient: string;
  configured: boolean;
  configuredAt: string | null;
  lastVerifyAt: string | null;
  lastVerifyOk: boolean | null;
  updatedAt: string;
};
