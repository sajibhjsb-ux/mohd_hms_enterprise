// MOHD.HMS ENTERPRISE — WhatsApp template catalog + rendering (§37/§38/§69).
// Plain-text bodies with {{VARIABLE}} placeholders. Variables are an
// ALLOWLIST resolved server-side from authorized data — never user-supplied
// expressions. Versioned: every send records the template version used.

import { db } from "@/lib/db";

export type TemplateSeed = {
  key: string;
  name: string;
  category: string;
  description: string;
  body: string;
  variables: string[];
  critical?: boolean;
};

export const TEMPLATE_CATALOG: TemplateSeed[] = [
  {
    key: "COMPLAINT_CREATED",
    name: "Complaint received (customer confirmation)",
    category: "COMPLAINT",
    description: "Sent to the customer right after a WhatsApp/portal complaint is created.",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "Your complaint has been received.\n\n" +
      "Complaint No: {{COMPLAINT_NUMBER}}\n" +
      "Description: {{COMPLAINT_TITLE}}\n\n" +
      "Our team will review your request and keep you updated.\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["CUSTOMER_NAME", "COMPLAINT_NUMBER", "COMPLAINT_TITLE", "COMPANY_NAME"],
  },
  {
    key: "COMPLAINT_ASSIGNED",
    name: "Complaint assigned (technician)",
    category: "COMPLAINT",
    description: "Notifies the assigned technician about a new complaint.",
    body:
      "New complaint assigned.\n\n" +
      "Complaint No: {{COMPLAINT_NUMBER}}\n" +
      "Customer: {{CUSTOMER_NAME}}\n" +
      "Description: {{COMPLAINT_TITLE}}\n" +
      "Priority: {{PRIORITY}}\n\n" +
      "Please check the MOHD.HMS portal for details.",
    variables: ["COMPLAINT_NUMBER", "CUSTOMER_NAME", "COMPLAINT_TITLE", "PRIORITY"],
  },
  {
    key: "WORK_ORDER_ASSIGNED",
    name: "Work order assigned (technician)",
    category: "WORK_ORDER",
    description: "Notifies the technician about an assigned work order.",
    body:
      "New work order assigned.\n\n" +
      "Work Order No: {{WORK_ORDER_NUMBER}}\n" +
      "Customer: {{CUSTOMER_NAME}}\n" +
      "Title: {{WORK_ORDER_TITLE}}\n" +
      "Priority: {{PRIORITY}}\n\n" +
      "Please check the MOHD.HMS portal for details.",
    variables: ["WORK_ORDER_NUMBER", "CUSTOMER_NAME", "WORK_ORDER_TITLE", "PRIORITY"],
  },
  {
    key: "WORK_ORDER_COMPLETED",
    name: "Work order completed (customer update)",
    category: "WORK_ORDER",
    description: "Tells the customer their work order is completed.",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "Your work order {{WORK_ORDER_NUMBER}} has been completed.\n\n" +
      "Thank you for choosing {{COMPANY_NAME}}.",
    variables: ["CUSTOMER_NAME", "WORK_ORDER_NUMBER", "COMPANY_NAME"],
  },
  {
    key: "QUOTATION_SENT",
    name: "Quotation sent (customer + PDF)",
    category: "QUOTATION",
    description: "Quotation notification; the finalized PDF is attached from MinIO.",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "Please find attached quotation {{QUOTATION_NUMBER}} ({{AMOUNT}}).\n\n" +
      "Valid until: {{DUE_DATE}}\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["CUSTOMER_NAME", "QUOTATION_NUMBER", "AMOUNT", "DUE_DATE", "COMPANY_NAME"],
  },
  {
    key: "INVOICE_SENT",
    name: "Invoice sent (customer + PDF)",
    category: "INVOICE",
    description: "Invoice notification; the finalized PDF is attached from MinIO.",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "Please find attached invoice {{INVOICE_NUMBER}} ({{AMOUNT}}).\n\n" +
      "Due date: {{DUE_DATE}}\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["CUSTOMER_NAME", "INVOICE_NUMBER", "AMOUNT", "DUE_DATE", "COMPANY_NAME"],
  },
  {
    key: "PAYMENT_RECEIVED",
    name: "Payment received (customer confirmation)",
    category: "PAYMENT",
    description: "Confirms a recorded payment against an invoice.",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "We have received your payment of {{AMOUNT}} for invoice {{INVOICE_NUMBER}}. Thank you.\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["CUSTOMER_NAME", "AMOUNT", "INVOICE_NUMBER", "COMPANY_NAME"],
  },
  {
    key: "PAYMENT_REMINDER",
    name: "Payment reminder (overdue invoice)",
    category: "PAYMENT",
    description: "Friendly reminder for an overdue invoice (rate-limited).",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "Invoice {{INVOICE_NUMBER}} ({{AMOUNT}}) was due on {{DUE_DATE}} and appears unpaid.\n\n" +
      "If you have already paid, please ignore this message.\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["CUSTOMER_NAME", "INVOICE_NUMBER", "AMOUNT", "DUE_DATE", "COMPANY_NAME"],
  },
  {
    key: "WA_HELP",
    name: "WhatsApp HELP menu",
    category: "SUPPORT",
    description: "Controlled auto-reply listing the supported WhatsApp commands.",
    body:
      "{{COMPANY_NAME}} Support:\n" +
      "1. Request Service — send SERVICE\n" +
      "2. Complaint Status — send STATUS\n" +
      "3. Work Order Status — send STATUS\n" +
      "4. Invoice — send INVOICE\n" +
      "5. Talk to Support — send AGENT\n\n" +
      "You can also describe your issue (e.g. \"AC not cooling\") and we will " +
      "log it as a service request.",
    variables: ["COMPANY_NAME"],
  },
  {
    key: "WA_STATUS_REPLY",
    name: "WhatsApp status reply",
    category: "SUPPORT",
    description: "Answers a STATUS request with the customer's latest complaint/work-order state.",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "{{STATUS_SUMMARY}}\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["CUSTOMER_NAME", "STATUS_SUMMARY", "COMPANY_NAME"],
  },
  {
    key: "WA_INVOICE_REPLY",
    name: "WhatsApp invoice reply",
    category: "SUPPORT",
    description: "Summarizes open invoices for the customer.",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "{{INVOICE_SUMMARY}}\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["CUSTOMER_NAME", "INVOICE_SUMMARY", "COMPANY_NAME"],
  },
  {
    key: "WA_UNKNOWN_CONTACT",
    name: "WhatsApp unknown-number reply",
    category: "SUPPORT",
    description: "Controlled response for numbers not linked to a customer account (§23).",
    body:
      "We could not identify your MOHD.HMS customer account. " +
      "Please provide your registered email or contact our support team.\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["COMPANY_NAME"],
  },
  {
    key: "WA_PROFILE_INCOMPLETE",
    name: "WhatsApp profile-completion reply",
    category: "SUPPORT",
    description: "Asks the customer to complete mobile + address before requesting service (§60).",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "Before we can log a service request we need your mobile number and address on file. " +
      "Please complete your profile in the MOHD.HMS portal or reply with your address.\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["CUSTOMER_NAME", "COMPANY_NAME"],
  },
  {
    key: "WA_HUMAN_HANDOFF",
    name: "WhatsApp human handoff confirmation",
    category: "SUPPORT",
    description: "Confirms a support-agent handoff (§26).",
    body:
      "Dear {{CUSTOMER_NAME}},\n\n" +
      "Your request has been forwarded to our support team. " +
      "A member of our team will contact you here as soon as possible.\n\n" +
      "{{COMPANY_NAME}}",
    variables: ["CUSTOMER_NAME", "COMPANY_NAME"],
  },
  {
    key: "GENERAL_NOTIFICATION",
    name: "General notification (staff/customer)",
    category: "NOTIFICATION",
    description: "Generic channel message used by the notification system.",
    body: "{{NOTIFICATION_TITLE}}\n\n{{NOTIFICATION_MESSAGE}}",
    variables: ["NOTIFICATION_TITLE", "NOTIFICATION_MESSAGE", "USER_NAME"],
  },
];

/** Automation seeds — REAL business events only (§30), mirroring email seeds. */
export type AutomationSeed = {
  name: string;
  eventType: string;
  templateKey: string;
  recipientRule: { kind: "CUSTOMER" | "RELATED_USER" | "ROLE" | "FIXED"; value?: string };
  attachments?: string[];
  dedupeHours?: number;
  enabled?: boolean;
};

export const AUTOMATION_SEEDS: AutomationSeed[] = [
  { name: "Complaint created → customer confirmation", eventType: "COMPLAINT_CREATED", templateKey: "COMPLAINT_CREATED", recipientRule: { kind: "CUSTOMER" }, dedupeHours: 24 },
  { name: "Complaint assigned → technician", eventType: "COMPLAINT_ASSIGNED", templateKey: "COMPLAINT_ASSIGNED", recipientRule: { kind: "RELATED_USER" }, dedupeHours: 24 },
  { name: "Work order assigned → technician", eventType: "WORK_ORDER_ASSIGNED", templateKey: "WORK_ORDER_ASSIGNED", recipientRule: { kind: "RELATED_USER" }, dedupeHours: 24 },
  { name: "Work order completed → customer update", eventType: "WORK_ORDER_COMPLETED", templateKey: "WORK_ORDER_COMPLETED", recipientRule: { kind: "CUSTOMER" }, dedupeHours: 24 },
  { name: "Quotation sent → customer (PDF)", eventType: "QUOTATION_SENT", templateKey: "QUOTATION_SENT", recipientRule: { kind: "CUSTOMER" }, attachments: ["QUOTATION_PDF"], dedupeHours: 24 },
  { name: "Invoice sent → customer (PDF)", eventType: "INVOICE_SENT", templateKey: "INVOICE_SENT", recipientRule: { kind: "CUSTOMER" }, attachments: ["INVOICE_PDF"], dedupeHours: 24 },
  { name: "Payment received → customer receipt", eventType: "PAYMENT_RECEIVED", templateKey: "PAYMENT_RECEIVED", recipientRule: { kind: "CUSTOMER" }, dedupeHours: 24 },
];

// ── Rendering ────────────────────────────────────────────────────────────────

const VARIABLE_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;

/**
 * Render a template body. Only variables in the template's declared allowlist
 * are substituted; unknown {{TOKENS}} are dropped (never executed, §37/§69).
 * Values are plain strings resolved server-side from authorized data.
 */
export function renderTemplate(body: string, data: Record<string, string>, allowed: string[]): string {
  const allow = new Set(allowed);
  return body.replace(VARIABLE_RE, (raw, name: string) => {
    if (!allow.has(name)) return ""; // unknown variable dropped — validation gate
    const v = data[name];
    return v === undefined || v === null ? "" : String(v);
  }).replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, ""); // any residual malformed token
}

/** Validate template content at save time: variables must be declared. */
export function extractVariables(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(VARIABLE_RE)) found.add(m[1]);
  return [...found];
}

export async function loadTemplateByKey(key: string) {
  return db.whatsAppTemplate.findFirst({ where: { key, deletedAt: null, isActive: true } });
}
