// MOHD.HMS ENTERPRISE — Canonical email template catalog (§8/§9/§10).
// ONLY events that actually exist in the application (verified against the
// DomainEvent emit sites + auth OTP flows + the HR letter workflow). The body
// here is the CONTENT SLOT — the branded shell (logo, header band, centralized
// footer) is applied by the layout wrapper, never duplicated per template.
//
// Bootstrap is idempotent (bootstrap.ts): templates are created only when the
// catalog key is missing; admin edits are NEVER overwritten.

import "server-only";

export type TemplateSeed = {
  key: string;
  name: string;
  category: string;
  description: string;
  subject: string;
  bodyHtml: string;
  variables: string[];
  critical?: boolean;
};

/** Small helpers to keep the catalog readable. */
const p = (s: string) => `<p style="margin:0 0 12px 0;">${s}</p>`;
const h = (s: string) => `<h2 style="margin:0 0 14px 0;font-size:18px;color:#14532d;">${s}</h2>`;
const box = (s: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 16px;">${s}</td></tr></table>`;
const btn = (label: string) =>
  `<p style="margin:18px 0 4px 0;">{{PORTAL_LINK_TEXT}}<a href="{{PORTAL_URL}}" style="display:inline-block;background-color:#16a34a;color:#ffffff;text-decoration:none;font-weight:600;font-size:13px;padding:10px 22px;border-radius:8px;">${label}</a></p>`;
const otpBox = () =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:10px 0 6px 0;"><div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#14532d;font-family:Consolas,Menlo,monospace;">{{OTP_CODE}}</div></td></tr></table>`;

export const TEMPLATE_CATALOG: TemplateSeed[] = [
  // ─── AUTHENTICATION (§45 — security-critical, never opt-out, never disabled) ──
  {
    key: "PASSWORD_RESET_OTP",
    name: "Password reset verification code",
    category: "AUTHENTICATION",
    description: "One-time code emailed when a user requests a password reset.",
    subject: "Your MOHD.HMS Enterprise password reset code",
    bodyHtml: [
      h("Password reset request"),
      p("Hi {{USER_NAME}},"),
      p("We received a request to reset the password for your MOHD.HMS Enterprise account ({{USER_EMAIL}}). Use the verification code below to continue:"),
      otpBox(),
      box(`<p style="margin:0;font-size:13px;">This code expires in <strong>{{OTP_EXPIRY_MINUTES}} minutes</strong> and can be used once. If you did not request a password reset, you can safely ignore this email — your password stays unchanged.</p>`),
    ].join(""),
    variables: ["USER_NAME", "USER_EMAIL", "OTP_CODE", "OTP_EXPIRY_MINUTES", "COMPANY_NAME"],
    critical: true,
  },
  {
    key: "EMAIL_VERIFICATION_OTP",
    name: "Email verification code",
    category: "AUTHENTICATION",
    description: "One-time code emailed to verify a user's email address.",
    subject: "Your MOHD.HMS Enterprise verification code",
    bodyHtml: [
      h("Verify your email address"),
      p("Hi {{USER_NAME}},"),
      p("Use the verification code below to verify the email address for your MOHD.HMS Enterprise account:"),
      otpBox(),
      box(`<p style="margin:0;font-size:13px;">This code expires in <strong>{{OTP_EXPIRY_MINUTES}} minutes</strong> and can be used once. If you did not request this code, you can safely ignore this email.</p>`),
    ].join(""),
    variables: ["USER_NAME", "USER_EMAIL", "OTP_CODE", "OTP_EXPIRY_MINUTES", "COMPANY_NAME"],
    critical: true,
  },

  // ─── COMPLAINTS (§48) ────────────────────────────────────────────────────────
  {
    key: "COMPLAINT_CREATED",
    name: "Complaint created (service team)",
    category: "COMPLAINTS",
    description: "Internal notification to the service mailbox when a customer files a complaint.",
    subject: "New complaint {{COMPLAINT_NUMBER}} — {{COMPLAINT_TITLE}}",
    bodyHtml: [
      h("New complaint received"),
      p("A new complaint has been logged and awaits triage."),
      box(`<p style="margin:0 0 4px 0;"><strong>{{COMPLAINT_NUMBER}}</strong> — {{COMPLAINT_TITLE}}</p><p style="margin:0;font-size:13px;">Customer: {{CUSTOMER_NAME}} · Priority: {{COMPLAINT_PRIORITY}} · Location: {{COMPLAINT_LOCATION}}</p>`),
      btn("Open complaint"),
    ].join(""),
    variables: ["COMPLAINT_NUMBER", "COMPLAINT_TITLE", "COMPLAINT_PRIORITY", "COMPLAINT_LOCATION", "COMPLAINT_STATUS", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "COMPLAINT_ASSIGNED",
    name: "Complaint assigned (technician)",
    category: "COMPLAINTS",
    description: "Emails the assigned technician when a complaint is assigned to them.",
    subject: "You have been assigned complaint {{COMPLAINT_NUMBER}}",
    bodyHtml: [
      h("New assignment"),
      p("Hi {{TECHNICIAN_NAME}},"),
      p("The following complaint has been assigned to you:"),
      box(`<p style="margin:0 0 4px 0;"><strong>{{COMPLAINT_NUMBER}}</strong> — {{COMPLAINT_TITLE}}</p><p style="margin:0;font-size:13px;">Priority: {{COMPLAINT_PRIORITY}} · Location: {{COMPLAINT_LOCATION}} · Customer: {{CUSTOMER_NAME}}</p>`),
      p("Please accept the assignment in the portal so a work order can be prepared."),
      btn("Open complaint"),
    ].join(""),
    variables: ["COMPLAINT_NUMBER", "COMPLAINT_TITLE", "COMPLAINT_PRIORITY", "COMPLAINT_LOCATION", "COMPLAINT_STATUS", "TECHNICIAN_NAME", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "COMPLAINT_COMPLETED",
    name: "Complaint completed (customer)",
    category: "COMPLAINTS",
    description: "Tells the customer the work on their complaint has been completed and asks for confirmation.",
    subject: "Your complaint {{COMPLAINT_NUMBER}} has been completed",
    bodyHtml: [
      h("Work completed"),
      p("Dear {{CUSTOMER_NAME}},"),
      p("The work on your complaint <strong>{{COMPLAINT_NUMBER}}</strong> — {{COMPLAINT_TITLE}} has been completed by our service team."),
      p("Please review the result in the customer portal and confirm that everything is in order. Your confirmation helps us close the ticket and finalize the documentation."),
      btn("Review & confirm"),
    ].join(""),
    variables: ["COMPLAINT_NUMBER", "COMPLAINT_TITLE", "COMPLAINT_STATUS", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },

  // ─── WORK ORDERS (§48) ──────────────────────────────────────────────────────
  {
    key: "WORK_ORDER_CREATED",
    name: "Work order created (technician)",
    category: "WORK_ORDERS",
    description: "Emails the technician when a work order is created for them.",
    subject: "New work order {{WORK_ORDER_NUMBER}}",
    bodyHtml: [
      h("New work order"),
      p("Hi {{TECHNICIAN_NAME}},"),
      box(`<p style="margin:0 0 4px 0;"><strong>{{WORK_ORDER_NUMBER}}</strong> — {{WORK_ORDER_TITLE}}</p><p style="margin:0;font-size:13px;">Priority: {{WORK_ORDER_PRIORITY}} · Location: {{COMPLAINT_LOCATION}}</p>`),
      p("Open the portal to review the checklist and accept the order."),
      btn("Open work order"),
    ].join(""),
    variables: ["WORK_ORDER_NUMBER", "WORK_ORDER_TITLE", "WORK_ORDER_PRIORITY", "WORK_ORDER_STATUS", "COMPLAINT_LOCATION", "TECHNICIAN_NAME", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "WORK_ORDER_COMPLETED",
    name: "Work order completed (customer)",
    category: "WORK_ORDERS",
    description: "Tells the customer a work order has been completed.",
    subject: "Work order {{WORK_ORDER_NUMBER}} completed",
    bodyHtml: [
      h("Work completed"),
      p("Dear {{CUSTOMER_NAME}},"),
      p("Work order <strong>{{WORK_ORDER_NUMBER}}</strong> — {{WORK_ORDER_TITLE}} has been completed."),
      p("Thank you for trusting MOHD.HMS Enterprise with your facility maintenance."),
      btn("View details"),
    ].join(""),
    variables: ["WORK_ORDER_NUMBER", "WORK_ORDER_TITLE", "WORK_ORDER_STATUS", "WORK_ORDER_TOTAL", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },

  // ─── QUOTATIONS (§46) ───────────────────────────────────────────────────────
  {
    key: "QUOTATION_SENT",
    name: "Quotation sent (customer + PDF)",
    category: "QUOTATIONS",
    description: "Sends the customer their quotation with the quotation PDF attached (MinIO/PDF engine).",
    subject: "Quotation {{QUOTATION_NUMBER}} from {{COMPANY_NAME}}",
    bodyHtml: [
      h("Your quotation is ready"),
      p("Dear {{CUSTOMER_NAME}},"),
      p("Please find attached our quotation <strong>{{QUOTATION_NUMBER}}</strong> dated {{QUOTATION_DATE}}."),
      box(`<p style="margin:0;font-size:13px;">Total: <strong>{{QUOTATION_TOTAL}}</strong> · Valid until: <strong>{{QUOTATION_VALID_UNTIL}}</strong></p>`),
      p("The PDF copy is attached to this email. We look forward to working with you."),
      btn("Open quotation"),
    ].join(""),
    variables: ["QUOTATION_NUMBER", "QUOTATION_DATE", "QUOTATION_TOTAL", "QUOTATION_VALID_UNTIL", "QUOTATION_STATUS", "CUSTOMER_NAME", "COMPANY_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "QUOTATION_ACCEPTED",
    name: "Quotation accepted (sales)",
    category: "QUOTATIONS",
    description: "Internal notification when a customer accepts a quotation.",
    subject: "Quotation {{QUOTATION_NUMBER}} accepted",
    bodyHtml: [
      h("Quotation accepted"),
      p("Customer <strong>{{CUSTOMER_NAME}}</strong> accepted quotation <strong>{{QUOTATION_NUMBER}}</strong> ({{QUOTATION_TOTAL}})."),
      p("Follow up in the portal to plan the conversion into work."),
      btn("Open quotation"),
    ].join(""),
    variables: ["QUOTATION_NUMBER", "QUOTATION_TOTAL", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "QUOTATION_EXPIRING",
    name: "Quotation expiring (sales)",
    category: "QUOTATIONS",
    description: "Internal reminder that a quotation is approaching its validity end (scheduler scan).",
    subject: "Quotation {{QUOTATION_NUMBER}} expires soon",
    bodyHtml: [
      h("Quotation expiring"),
      p("Quotation <strong>{{QUOTATION_NUMBER}}</strong> for {{CUSTOMER_NAME}} ({{QUOTATION_TOTAL}}) is valid until <strong>{{QUOTATION_VALID_UNTIL}}</strong>."),
      p("Consider following up with the customer before it expires."),
      btn("Open quotation"),
    ].join(""),
    variables: ["QUOTATION_NUMBER", "QUOTATION_TOTAL", "QUOTATION_VALID_UNTIL", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },

  // ─── INVOICES / PAYMENTS (§47) ──────────────────────────────────────────────
  {
    key: "INVOICE_SENT",
    name: "Invoice sent (customer + PDF)",
    category: "INVOICES",
    description: "Sends the customer their invoice with the invoice PDF attached (MinIO/PDF engine).",
    subject: "Invoice {{INVOICE_NUMBER}} from {{COMPANY_NAME}}",
    bodyHtml: [
      h("Your invoice"),
      p("Dear {{CUSTOMER_NAME}},"),
      p("Please find attached invoice <strong>{{INVOICE_NUMBER}}</strong> dated {{INVOICE_DATE}}."),
      box(`<p style="margin:0;font-size:13px;">Total: <strong>{{INVOICE_TOTAL}}</strong> · Due date: <strong>{{INVOICE_DUE_DATE}}</strong></p>`),
      p("The PDF copy is attached. Payment instructions are included in the document."),
      btn("View invoice"),
    ].join(""),
    variables: ["INVOICE_NUMBER", "INVOICE_DATE", "INVOICE_DUE_DATE", "INVOICE_TOTAL", "INVOICE_STATUS", "CUSTOMER_NAME", "COMPANY_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "INVOICE_DUE_SOON",
    name: "Invoice due soon (customer)",
    category: "INVOICES",
    description: "Friendly reminder to the customer before an invoice becomes due (scheduler scan).",
    subject: "Reminder: invoice {{INVOICE_NUMBER}} is due on {{INVOICE_DUE_DATE}}",
    bodyHtml: [
      h("Payment reminder"),
      p("Dear {{CUSTOMER_NAME}},"),
      p("This is a friendly reminder that invoice <strong>{{INVOICE_NUMBER}}</strong> ({{INVOICE_TOTAL}}) is due on <strong>{{INVOICE_DUE_DATE}}</strong>."),
      p("If you have already arranged payment, please disregard this reminder."),
      btn("View invoice"),
    ].join(""),
    variables: ["INVOICE_NUMBER", "INVOICE_DUE_DATE", "INVOICE_TOTAL", "INVOICE_BALANCE", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "INVOICE_OVERDUE",
    name: "Invoice overdue (finance)",
    category: "INVOICES",
    description: "Internal escalation to the finance mailbox when an invoice passes its due date.",
    subject: "Invoice {{INVOICE_NUMBER}} is overdue",
    bodyHtml: [
      h("Invoice overdue"),
      p("Invoice <strong>{{INVOICE_NUMBER}}</strong> for {{CUSTOMER_NAME}} passed its due date ({{INVOICE_DUE_DATE}})."),
      box(`<p style="margin:0;font-size:13px;">Outstanding balance: <strong>{{INVOICE_BALANCE}}</strong></p>`),
      btn("Open invoice"),
    ].join(""),
    variables: ["INVOICE_NUMBER", "INVOICE_DUE_DATE", "INVOICE_BALANCE", "INVOICE_TOTAL", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "PAYMENT_RECEIVED",
    name: "Payment received (customer receipt)",
    category: "PAYMENTS",
    description: "Thank-you receipt to the customer when a payment is recorded.",
    subject: "Payment received for invoice {{INVOICE_NUMBER}}",
    bodyHtml: [
      h("Thank you for your payment"),
      p("Dear {{CUSTOMER_NAME}},"),
      p("We have received your payment of <strong>{{PAYMENT_AMOUNT}}</strong> on {{PAYMENT_DATE}} for invoice <strong>{{INVOICE_NUMBER}}</strong>."),
      box(`<p style="margin:0;font-size:13px;">Remaining balance: <strong>{{INVOICE_BALANCE}}</strong></p>`),
      p("A receipt document is available in the customer portal."),
      btn("View receipt"),
    ].join(""),
    variables: ["PAYMENT_AMOUNT", "PAYMENT_DATE", "INVOICE_NUMBER", "INVOICE_BALANCE", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },

  // ─── PM (scheduler events exist) ────────────────────────────────────────────
  {
    key: "PM_REMINDER",
    name: "PM task reminder (technician)",
    category: "WORK_ORDERS",
    description: "Reminds the assigned technician that a preventive maintenance task is coming due.",
    subject: "PM reminder: {{PM_PLAN_CODE}} due on {{PM_DUE_DATE}}",
    bodyHtml: [
      h("Preventive maintenance reminder"),
      p("Hi {{TECHNICIAN_NAME}},"),
      box(`<p style="margin:0 0 4px 0;"><strong>{{PM_PLAN_CODE}}</strong> — {{PM_PLAN_NAME}}</p><p style="margin:0;font-size:13px;">Equipment: {{EQUIPMENT_NAME}} · Due: <strong>{{PM_DUE_DATE}}</strong></p>`),
      p("Please schedule the maintenance visit and keep the task status up to date."),
      btn("Open PM task"),
    ].join(""),
    variables: ["PM_PLAN_CODE", "PM_PLAN_NAME", "PM_DUE_DATE", "EQUIPMENT_NAME", "TECHNICIAN_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "PM_OVERDUE",
    name: "PM overdue (service team)",
    category: "WORK_ORDERS",
    description: "Internal escalation when a PM task passes its due date.",
    subject: "PM task {{PM_PLAN_CODE}} is overdue",
    bodyHtml: [
      h("Preventive maintenance overdue"),
      box(`<p style="margin:0 0 4px 0;"><strong>{{PM_PLAN_CODE}}</strong> — {{PM_PLAN_NAME}}</p><p style="margin:0;font-size:13px;">Equipment: {{EQUIPMENT_NAME}} · Was due: <strong>{{PM_DUE_DATE}}</strong></p>`),
      p("The assigned technician has been reminded; please follow up if the task stays open."),
      btn("Open PM task"),
    ].join(""),
    variables: ["PM_PLAN_CODE", "PM_PLAN_NAME", "PM_DUE_DATE", "EQUIPMENT_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },

  // ─── PURCHASES (§24 routing — procurement mailbox) ──────────────────────────
  {
    key: "PURCHASE_CREATED",
    name: "Purchase order created (procurement)",
    category: "PURCHASES",
    description: "Notifies the procurement mailbox when a purchase order is raised.",
    subject: "Purchase order {{PURCHASE_NUMBER}} created",
    bodyHtml: [
      h("New purchase order"),
      box(`<p style="margin:0 0 4px 0;"><strong>{{PURCHASE_NUMBER}}</strong></p><p style="margin:0;font-size:13px;">Supplier: {{SUPPLIER_NAME}} · Total: {{PURCHASE_TOTAL}}</p>`),
      btn("Open purchase order"),
    ].join(""),
    variables: ["PURCHASE_NUMBER", "SUPPLIER_NAME", "PURCHASE_TOTAL", "PURCHASE_STATUS", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },

  // ─── IRMS (§50) ─────────────────────────────────────────────────────────────
  {
    key: "IRMS_REPORT_SUBMITTED",
    name: "Inspection report submitted (inspection team)",
    category: "IRMS",
    description: "Notifies the inspection mailbox that a report awaits review.",
    subject: "Inspection report {{REPORT_NUMBER}} submitted",
    bodyHtml: [
      h("Inspection report submitted"),
      box(`<p style="margin:0 0 4px 0;"><strong>{{REPORT_NUMBER}}</strong> — {{PROJECT_NAME}}</p><p style="margin:0;font-size:13px;">Inspector: {{INSPECTOR_NAME}} · Customer: {{CUSTOMER_NAME}}</p>`),
      p("The report is now in review. Open the portal to continue the workflow."),
      btn("Open report"),
    ].join(""),
    variables: ["REPORT_NUMBER", "PROJECT_NAME", "INSPECTOR_NAME", "CUSTOMER_NAME", "REPORT_STATUS", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "IRMS_REPORT_APPROVED",
    name: "Inspection report approved (customer + PDF)",
    category: "IRMS",
    description: "Sends the customer the approved inspection report with the final PDF attached.",
    subject: "Inspection report {{REPORT_NUMBER}} approved",
    bodyHtml: [
      h("Inspection report approved"),
      p("Dear {{CUSTOMER_NAME}},"),
      p("Inspection report <strong>{{REPORT_NUMBER}}</strong> for {{PROJECT_NAME}} has been approved and is attached to this email."),
      p("Thank you for working with MOHD.HMS Enterprise."),
      btn("View report"),
    ].join(""),
    variables: ["REPORT_NUMBER", "PROJECT_NAME", "REPORT_STATUS", "INSPECTOR_NAME", "CUSTOMER_NAME", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },

  // ─── LETTERS (§49 — HR letter system) ───────────────────────────────────────
  {
    key: "HR_LETTER_SENT",
    name: "HR letter delivered (recipient + PDF)",
    category: "LETTERS",
    description: "Delivers a finalized HR letter to its recipient with the final PDF attached (MinIO).",
    subject: "{{LETTER_SUBJECT}} — {{COMPANY_NAME}}",
    bodyHtml: [
      p("Dear Recipient,"),
      p("Please find attached the official letter <strong>{{LETTER_NUMBER}}</strong> dated {{LETTER_DATE}}."),
      box(`<p style="margin:0;font-size:13px;">Subject: <strong>{{LETTER_SUBJECT}}</strong></p>`),
      p("This letter is issued by MOHD.HMS Enterprise. If you have any questions, please contact our office."),
    ].join(""),
    variables: ["LETTER_NUMBER", "LETTER_DATE", "LETTER_SUBJECT", "COMPANY_NAME"],
  },
  {
    key: "HR_LETTER_APPROVED",
    name: "HR letter approved (HR team)",
    category: "HR",
    description: "Internal notification that an HR letter was approved and can be finalized.",
    subject: "Letter {{LETTER_NUMBER}} approved",
    bodyHtml: [
      h("Letter approved"),
      p("Letter <strong>{{LETTER_NUMBER}}</strong> ({{LETTER_SUBJECT}}) has been approved."),
      p("It can now be finalized to produce the immutable PDF copy."),
      btn("Open letter"),
    ].join(""),
    variables: ["LETTER_NUMBER", "LETTER_SUBJECT", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },

  // ─── SYSTEM (§51 — same domain event, separate delivery channel) ────────────
  {
    key: "GENERAL_NOTIFICATION",
    name: "General notification email",
    category: "SYSTEM",
    description: "Generic email channel delivery for business notifications (complaint assigned, invoice sent…).",
    subject: "{{NOTIFICATION_TITLE}}",
    bodyHtml: [
      p("Hi {{USER_NAME}},"),
      p("{{NOTIFICATION_MESSAGE}}"),
      btn("Open MOHD.HMS"),
    ].join(""),
    variables: ["USER_NAME", "USER_EMAIL", "NOTIFICATION_TITLE", "NOTIFICATION_MESSAGE", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
  {
    key: "SYSTEM_ALERT",
    name: "System alert (staff mailboxes)",
    category: "SYSTEM",
    description: "Operational alerts — low stock, SLA breach, escalations — to the responsible mailbox.",
    subject: "{{ALERT_TITLE}}",
    bodyHtml: [
      box(`<p style="margin:0 0 4px 0;"><strong>{{ALERT_TITLE}}</strong></p><p style="margin:0;font-size:13px;">{{ALERT_MESSAGE}}</p>`),
      btn("Open MOHD.HMS"),
    ].join(""),
    variables: ["ALERT_TITLE", "ALERT_MESSAGE", "PORTAL_URL", "PORTAL_LINK_TEXT"],
  },
];

/** Variables shared by every template (injected at render time). */
export const GLOBAL_VARIABLES = [
  "COMPANY_NAME", "COMPANY_ADDRESS", "COMPANY_PHONE", "COMPANY_EMAIL", "COMPANY_WEBSITE",
  "PORTAL_URL", "PORTAL_LINK_TEXT",
] as const;

// ─── Default automation seeds (§15/§32 — created once, admin-editable) ──────

export type AutomationSeed = {
  name: string;
  eventType: string;
  templateKey: string;
  recipientRule: Record<string, unknown>;
  attachments?: string[]; // AttachmentKind[]
  conditions?: Record<string, unknown>[];
  critical?: boolean;
  enabled: boolean;
};

export const AUTOMATION_SEEDS: AutomationSeed[] = [
  { name: "Password reset OTP email", eventType: "__OTP_PASSWORD_RESET__", templateKey: "PASSWORD_RESET_OTP", recipientRule: { kind: "RELATED_USER" }, critical: true, enabled: true },
  { name: "Email verification OTP", eventType: "__OTP_EMAIL_VERIFICATION__", templateKey: "EMAIL_VERIFICATION_OTP", recipientRule: { kind: "RELATED_USER" }, critical: true, enabled: true },
  { name: "Complaint created → service mailbox", eventType: "COMPLAINT_CREATED", templateKey: "COMPLAINT_CREATED", recipientRule: { kind: "MODULE_MAILBOX", value: "company_email_service" }, enabled: true },
  { name: "Complaint assigned → technician", eventType: "COMPLAINT_ASSIGNED", templateKey: "COMPLAINT_ASSIGNED", recipientRule: { kind: "RELATED_USER" }, enabled: true },
  { name: "Complaint completed → customer", eventType: "COMPLAINT_COMPLETED", templateKey: "COMPLAINT_COMPLETED", recipientRule: { kind: "CUSTOMER" }, enabled: true },
  { name: "Work order completed → customer", eventType: "WORK_ORDER_COMPLETED", templateKey: "WORK_ORDER_COMPLETED", recipientRule: { kind: "CUSTOMER" }, enabled: true },
  { name: "Quotation sent → customer (PDF)", eventType: "QUOTATION_SENT", templateKey: "QUOTATION_SENT", recipientRule: { kind: "CUSTOMER" }, attachments: ["QUOTATION_PDF"], enabled: true },
  { name: "Quotation accepted → sales", eventType: "QUOTATION_ACCEPTED", templateKey: "QUOTATION_ACCEPTED", recipientRule: { kind: "MODULE_MAILBOX", value: "company_email_sales" }, enabled: true },
  { name: "Quotation expiring → sales", eventType: "QUOTATION_EXPIRING", templateKey: "QUOTATION_EXPIRING", recipientRule: { kind: "MODULE_MAILBOX", value: "company_email_sales" }, enabled: true },
  { name: "Invoice sent → customer (PDF)", eventType: "INVOICE_SENT", templateKey: "INVOICE_SENT", recipientRule: { kind: "CUSTOMER" }, attachments: ["INVOICE_PDF"], enabled: true },
  { name: "Invoice due soon → customer", eventType: "INVOICE_DUE_SOON", templateKey: "INVOICE_DUE_SOON", recipientRule: { kind: "CUSTOMER" }, enabled: true },
  { name: "Invoice overdue → finance", eventType: "INVOICE_OVERDUE", templateKey: "INVOICE_OVERDUE", recipientRule: { kind: "MODULE_MAILBOX", value: "company_email_finance" }, enabled: true },
  { name: "Payment received → customer receipt", eventType: "PAYMENT_RECEIVED", templateKey: "PAYMENT_RECEIVED", recipientRule: { kind: "CUSTOMER" }, attachments: ["PAYMENT_RECEIPT_PDF"], enabled: true },
  { name: "PM reminder → technician", eventType: "PM_REMINDER", templateKey: "PM_REMINDER", recipientRule: { kind: "RELATED_USER" }, enabled: true },
  { name: "PM overdue → service mailbox", eventType: "PM_OVERDUE", templateKey: "PM_OVERDUE", recipientRule: { kind: "MODULE_MAILBOX", value: "company_email_service" }, enabled: true },
  { name: "Purchase order created → procurement", eventType: "PURCHASE_CREATED", templateKey: "PURCHASE_CREATED", recipientRule: { kind: "MODULE_MAILBOX", value: "company_email_procurement" }, enabled: true },
  { name: "Inspection report submitted → inspection", eventType: "INSPECTION_SUBMITTED", templateKey: "IRMS_REPORT_SUBMITTED", recipientRule: { kind: "MODULE_MAILBOX", value: "company_email_inspection" }, enabled: true },
  { name: "Inspection report approved → customer (PDF)", eventType: "INSPECTION_APPROVED", templateKey: "IRMS_REPORT_APPROVED", recipientRule: { kind: "CUSTOMER" }, attachments: ["INSPECTION_PDF"], enabled: true },
  { name: "HR letter approved → HR", eventType: "LETTER_APPROVED", templateKey: "HR_LETTER_APPROVED", recipientRule: { kind: "MODULE_MAILBOX", value: "company_email_hr" }, enabled: true },
  { name: "Low stock alert → procurement", eventType: "LOW_STOCK", templateKey: "SYSTEM_ALERT", recipientRule: { kind: "MODULE_MAILBOX", value: "company_email_procurement" }, enabled: true },
];
