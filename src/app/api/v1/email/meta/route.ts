// MOHD.HMS ENTERPRISE — Email admin metadata (§26 UI support).
// Provides the controlled vocabularies the admin UI renders: event types that
// carry email automations, categories, recipient rule kinds, module mailboxes
// (from the canonical company settings), attachment kinds and template keys.

import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { EMAIL_AUTOMATION_EVENTS } from "@/lib/hms/email/workflows";
import { EMAIL_CATEGORIES } from "@/lib/hms/email/types";

const MODULE_MAILBOXES = [
  { key: "company_email_sales", label: "Sales / Quotations" },
  { key: "company_email_service", label: "Service / Operations" },
  { key: "company_email_finance", label: "Finance" },
  { key: "company_email_hr", label: "HR" },
  { key: "company_email_procurement", label: "Procurement" },
  { key: "company_email_inspection", label: "Inspection" },
  { key: "company_email_info", label: "General / Info" },
];

export const GET = handler(
  async () => {
    const [templates, mailboxes] = await Promise.all([
      db.emailTemplate.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: [{ category: "asc" }, { name: "asc" }],
        select: { key: true, name: true, category: true, critical: true },
      }),
      db.setting.findMany({ where: { key: { in: MODULE_MAILBOXES.map((m) => m.key) } } }),
    ]);
    const mailboxValues = Object.fromEntries(mailboxes.map((s) => [s.key, s.value]));
    return ok({
      events: EMAIL_AUTOMATION_EVENTS,
      categories: EMAIL_CATEGORIES,
      templates,
      recipientKinds: ["CUSTOMER", "RELATED_USER", "ROLE", "MODULE_MAILBOX", "FIXED"],
      moduleMailboxes: MODULE_MAILBOXES.map((m) => ({ ...m, value: mailboxValues[m.key] ?? "" })),
      attachmentKinds: ["INVOICE_PDF", "QUOTATION_PDF", "WO_PDF", "INSPECTION_PDF", "LETTER_PDF", "PAYMENT_RECEIPT_PDF"],
      roles: ["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "CUSTOMER", "FINANCE", "HR"],
      conditionOps: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "exists"],
    });
  },
  { permission: PERMISSIONS.email_view }
);
