// MOHD.HMS ENTERPRISE — Document template METADATA registry (Settings → Templates).
//
// THE source of truth for:
//   • which PDF document types are templateable (exactly the keys of the
//     central PDF registry in documents.ts — one registry, no parallel system),
//   • the BLOCK catalog per document type (ids, labels, required blocks),
//   • the safe VARIABLE catalog per document type (§12/§13),
//   • layout JSON sanitization + publish-time validation (§14/§46).
//
// Client-safe (the Settings editor imports it too) — NO server-only import,
// NO Prisma, NO rendering. Block RENDERERS live in documents.ts keyed by the
// same ids; a module-init assertion in documents.ts keeps both sides in sync.

import { sanitizeStyle, styleReadabilityWarnings, type TemplateStyle } from "./template-style";

// ── document types ──────────────────────────────────────────────────────────

export const TEMPLATE_TYPES = [
  "invoice",
  "quotation",
  "inspection-report",
  "work-order",
  "pm-task",
  "equipment-report",
  "complaint",
  "purchase-order",
  "payment-receipt",
] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export const TEMPLATE_TYPE_NAMES: Record<TemplateType, string> = {
  invoice: "Invoice",
  quotation: "Quotation",
  "inspection-report": "Inspection Report",
  "work-order": "Work Order",
  "pm-task": "PM Service Sheet",
  "equipment-report": "Equipment / Project Report",
  complaint: "Complaint Report",
  "purchase-order": "Purchase Order",
  "payment-receipt": "Payment Receipt",
};

/** Settings → Templates home cards (§3) — grouped by business document family. */
export const TEMPLATE_GROUPS: { key: string; label: string; description: string; types: TemplateType[] }[] = [
  { key: "invoice", label: "Invoice", description: "Customer invoices & payment summaries", types: ["invoice"] },
  { key: "quotation", label: "Quotation", description: "Priced quotations & proposals", types: ["quotation"] },
  { key: "inspection", label: "Inspection Report", description: "IRMS inspection reports & findings", types: ["inspection-report"] },
  { key: "work-order", label: "Work Order", description: "Job cards & service worksheets", types: ["work-order"] },
  { key: "project", label: "Project Report", description: "Equipment / project history reports", types: ["equipment-report"] },
  { key: "pm", label: "PM Report", description: "Preventive maintenance service sheets", types: ["pm-task"] },
  { key: "other", label: "Other Reports", description: "Complaints, purchase orders, receipts", types: ["complaint", "purchase-order", "payment-receipt"] },
];

// ── blocks ──────────────────────────────────────────────────────────────────

export type BlockGroup = "content" | "financial" | "media" | "approval" | "meta";

export type BlockMeta = {
  id: string;
  label: string;
  description?: string;
  group: BlockGroup;
  /** Security/compliance-critical block that can never be hidden (e.g. QR). */
  required?: boolean;
  /** Editable per-block configuration keys (drives the editor's config panel). */
  config?: ("text" | "photoColumns")[];
};

const QR: BlockMeta = {
  id: "qr",
  label: "QR Verification",
  description: "Centralized app.mohdhms.com verification code — always the last element",
  group: "meta",
  required: true,
};

const CUSTOM_TEXT: BlockMeta = {
  id: "custom-text",
  label: "Custom Text",
  description: "Your own note with {{variables}} — add it to the layout to use it",
  group: "content",
  config: ["text"],
};

export const BLOCK_META: Record<TemplateType, BlockMeta[]> = {
  invoice: [
    { id: "summary", label: "Invoice Details", description: "Number, dates, customer, references", group: "content" },
    { id: "items", label: "Line Items Table", description: "Dynamic item table (# / Description / Qty / Rate)", group: "financial" },
    { id: "totals", label: "Totals", description: "Subtotal → Balance Due block", group: "financial" },
    { id: "balance-banner", label: "Balance Banner", description: "Paid-in-full / balance-due status line", group: "financial" },
    { id: "payments", label: "Payments Received", description: "Payment history table (when payments exist)", group: "financial" },
    { id: "currency-banner", label: "Currency Note", description: "BND currency declaration", group: "meta" },
    { id: "notes", label: "Notes", group: "content" },
    { id: "terms", label: "Terms", group: "content" },
    QR,
    CUSTOM_TEXT,
  ],
  quotation: [
    { id: "summary", label: "Quotation Details", description: "Number, validity, customer", group: "content" },
    { id: "items", label: "Itemised Pricing Table", description: "Dynamic item table (# / Description / Qty / Unit Rate)", group: "financial" },
    { id: "totals", label: "Totals", description: "Subtotal → Grand Total block", group: "financial" },
    { id: "currency-banner", label: "Currency Note", description: "BND currency declaration", group: "meta" },
    { id: "notes", label: "Notes", group: "content" },
    { id: "terms", label: "Terms & Conditions", group: "content" },
    { id: "signatures", label: "Signature Block", description: "Company / customer acceptance lines", group: "approval" },
    QR,
    CUSTOM_TEXT,
  ],
  "inspection-report": [
    { id: "job-info", label: "Job Information", description: "Job order, project, client, equipment, inspector", group: "content" },
    { id: "work-description", label: "Work Description", group: "content" },
    { id: "summary", label: "Summary", group: "content" },
    { id: "findings", label: "Findings Table", description: "# / Finding / Severity / Recommended Action", group: "content" },
    { id: "work-details", label: "Work Details", description: "Scope, corrective actions, root cause, hours, completion", group: "content" },
    { id: "recommendations", label: "Recommendations", group: "content" },
    { id: "photos-before", label: "Photos — Before", description: "Before photographs (aspect-ratio preserving grid)", group: "media", config: ["photoColumns"] },
    { id: "photos-during", label: "Photos — During", group: "media", config: ["photoColumns"] },
    { id: "photos-after", label: "Photos — After", group: "media", config: ["photoColumns"] },
    { id: "signatures", label: "Signature Block", description: "Role signatures with captured signature images", group: "approval" },
    { id: "approval-history", label: "Approval History", description: "Workflow transitions table", group: "approval" },
    { id: "revision-note", label: "Revision Note", description: "Revision + client comment line", group: "meta" },
    QR,
    CUSTOM_TEXT,
  ],
  "work-order": [
    { id: "summary", label: "Work Order Details", description: "Number, status, priority, customer, equipment, technician", group: "content" },
    { id: "description", label: "Description", group: "content" },
    { id: "checklist", label: "Checklist Table", description: "Structured checklist results", group: "content" },
    { id: "labour-materials", label: "Labour & Materials Table", group: "financial" },
    { id: "totals", label: "Totals", description: "Labour / materials / grand total", group: "financial" },
    { id: "notes", label: "Notes", group: "content" },
    { id: "confirmation", label: "Customer Confirmation Banner", group: "approval" },
    { id: "signatures", label: "Signature Block", description: "Technician / customer signatures", group: "approval" },
    QR,
    CUSTOM_TEXT,
  ],
  "pm-task": [
    { id: "summary", label: "PM Task Details", description: "Task, plan, equipment, technician, progress", group: "content" },
    { id: "checklist", label: "Service Checklist Table", group: "content" },
    { id: "notes", label: "Technician Notes", group: "content" },
    { id: "signatures", label: "Signature Block", description: "Technician / supervisor signatures", group: "approval" },
    QR,
    CUSTOM_TEXT,
  ],
  "equipment-report": [
    { id: "summary", label: "Equipment Details", description: "Asset tag, model, serial, location, warranty", group: "content" },
    { id: "notes", label: "Notes", group: "content" },
    { id: "pm-plans", label: "PM Plans Table", group: "content" },
    { id: "recent-work-orders", label: "Recent Work Orders Table", group: "content" },
    { id: "recent-complaints", label: "Recent Complaints Table", group: "content" },
    QR,
    CUSTOM_TEXT,
  ],
  complaint: [
    { id: "summary", label: "Complaint Details", description: "Number, status, priority, customer, timeline", group: "content" },
    { id: "description", label: "Description", group: "content" },
    { id: "resolution", label: "Resolution", group: "content" },
    { id: "customer-confirmation", label: "Customer Confirmation", description: "Rating + feedback", group: "approval" },
    { id: "linked-work-orders", label: "Linked Work Orders Table", group: "content" },
    { id: "status-timeline", label: "Status Timeline Table", group: "content" },
    QR,
    CUSTOM_TEXT,
  ],
  "purchase-order": [
    { id: "summary", label: "Order Details", description: "Number, dates, supplier", group: "content" },
    { id: "items", label: "Ordered Items Table", description: "# / Description / Qty / Received / Unit Cost / Total", group: "financial" },
    { id: "totals", label: "Totals", group: "financial" },
    { id: "currency-banner", label: "Currency Note", group: "meta" },
    { id: "approval-note", label: "Approval Note", description: "Approval date line", group: "approval" },
    { id: "notes", label: "Notes", group: "content" },
    { id: "signatures", label: "Signature Block", description: "Approved by / received by", group: "approval" },
    QR,
    CUSTOM_TEXT,
  ],
  "payment-receipt": [
    { id: "thanks-banner", label: "Thank-you Banner", description: "Payment received headline", group: "content" },
    { id: "summary", label: "Receipt Details", description: "Receipt, method, payer, invoice", group: "content" },
    { id: "invoice-position", label: "Invoice Position", description: "Invoice total / paid / remaining", group: "financial" },
    { id: "remarks", label: "Remarks", group: "content" },
    { id: "currency-banner", label: "Currency Note", group: "meta" },
    { id: "signatures", label: "Signature Block", description: "Company / payer acknowledgement", group: "approval" },
    QR,
    CUSTOM_TEXT,
  ],
};

/** Canonical block order for a type = the declared order (what the built-in
 *  layout renders). The editor initializes from this. */
export function defaultBlockOrder(type: TemplateType): string[] {
  return BLOCK_META[type].map((b) => b.id);
}

// ── variables (§12/§13) ─────────────────────────────────────────────────────

export type TemplateVariable = { key: string; label: string };

export const TEMPLATE_VARIABLES: Record<TemplateType, TemplateVariable[]> = {
  invoice: [
    { key: "invoice_number", label: "Invoice Number" },
    { key: "invoice_date", label: "Invoice Date" },
    { key: "due_date", label: "Due Date" },
    { key: "status", label: "Payment Status" },
    { key: "customer_name", label: "Customer Name" },
    { key: "customer_address", label: "Customer Address" },
    { key: "customer_contact", label: "Customer Contact" },
    { key: "quotation_ref", label: "Quotation Ref" },
    { key: "work_order_refs", label: "Work Order Refs" },
    { key: "item_count", label: "Item Count" },
    { key: "subtotal", label: "Subtotal" },
    { key: "discount", label: "Discount" },
    { key: "shipping", label: "Shipping" },
    { key: "tax", label: "Tax" },
    { key: "total", label: "Total" },
    { key: "amount_paid", label: "Amount Paid" },
    { key: "balance", label: "Balance Due" },
    { key: "company_name", label: "Company Name" },
  ],
  quotation: [
    { key: "quotation_number", label: "Quotation Number" },
    { key: "quotation_date", label: "Quotation Date" },
    { key: "valid_until", label: "Valid Until" },
    { key: "status", label: "Status" },
    { key: "customer_name", label: "Customer Name" },
    { key: "customer_address", label: "Customer Address" },
    { key: "customer_contact", label: "Customer Contact" },
    { key: "item_count", label: "Item Count" },
    { key: "subtotal", label: "Subtotal" },
    { key: "discount", label: "Discount" },
    { key: "shipping", label: "Shipping" },
    { key: "tax", label: "Tax" },
    { key: "total", label: "Grand Total" },
    { key: "company_name", label: "Company Name" },
  ],
  "inspection-report": [
    { key: "inspection_number", label: "Report Number" },
    { key: "project_number", label: "Project Number" },
    { key: "project_name", label: "Project Name" },
    { key: "client", label: "Client" },
    { key: "equipment", label: "Equipment" },
    { key: "inspector", label: "Inspector" },
    { key: "inspection_date", label: "Inspection Date" },
    { key: "status", label: "Report Status" },
    { key: "overall_condition", label: "Overall Condition" },
    { key: "revision", label: "Revision" },
    { key: "finding_count", label: "Finding Count" },
    { key: "company_name", label: "Company Name" },
  ],
  "work-order": [
    { key: "work_order_number", label: "Work Order Number" },
    { key: "status", label: "Status" },
    { key: "priority", label: "Priority" },
    { key: "customer_name", label: "Customer Name" },
    { key: "equipment", label: "Equipment" },
    { key: "technician", label: "Technician" },
    { key: "scheduled_date", label: "Scheduled Date" },
    { key: "total", label: "Grand Total" },
    { key: "company_name", label: "Company Name" },
  ],
  "pm-task": [
    { key: "task_number", label: "Task Number" },
    { key: "status", label: "Status" },
    { key: "plan_name", label: "Plan Name" },
    { key: "equipment", label: "Equipment" },
    { key: "technician", label: "Technician" },
    { key: "due_date", label: "Due Date" },
    { key: "company_name", label: "Company Name" },
  ],
  "equipment-report": [
    { key: "asset_tag", label: "Asset Tag" },
    { key: "name", label: "Equipment Name" },
    { key: "category", label: "Category" },
    { key: "status", label: "Status" },
    { key: "manufacturer", label: "Manufacturer" },
    { key: "model", label: "Model" },
    { key: "serial_number", label: "Serial Number" },
    { key: "location", label: "Location" },
    { key: "customer_name", label: "Customer Name" },
    { key: "company_name", label: "Company Name" },
  ],
  complaint: [
    { key: "complaint_number", label: "Complaint Number" },
    { key: "status", label: "Status" },
    { key: "priority", label: "Priority" },
    { key: "customer_name", label: "Customer Name" },
    { key: "equipment", label: "Equipment" },
    { key: "technician", label: "Technician" },
    { key: "company_name", label: "Company Name" },
  ],
  "purchase-order": [
    { key: "po_number", label: "PO Number" },
    { key: "order_date", label: "Order Date" },
    { key: "expected_delivery", label: "Expected Delivery" },
    { key: "status", label: "Status" },
    { key: "supplier_name", label: "Supplier Name" },
    { key: "total", label: "Grand Total" },
    { key: "company_name", label: "Company Name" },
  ],
  "payment-receipt": [
    { key: "receipt_number", label: "Receipt Number" },
    { key: "receipt_date", label: "Receipt Date" },
    { key: "method", label: "Payment Method" },
    { key: "reference", label: "Reference" },
    { key: "received_from", label: "Received From" },
    { key: "invoice_number", label: "Invoice Number" },
    { key: "amount", label: "Amount" },
    { key: "company_name", label: "Company Name" },
  ],
};

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Safe {{variable}} substitution (§45) — only catalog keys resolve; anything
 *  else becomes an empty string. Templates never execute code. */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return String(text ?? "").replace(VAR_RE, (_m, key: string) => vars[key] ?? "");
}

export function extractVarKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(VAR_RE)) out.push(m[1]);
  return [...new Set(out)];
}

// ── layout JSON (§10/§11 — controlled component model, no code) ─────────────

export type TemplateLayout = {
  /** Block ids in render order (subset of BLOCK_META ids; required blocks are
   *  auto-appended when missing). */
  order: string[];
  /** Hidden optional blocks. */
  hidden: string[];
  /** Block id → heading override (empty = block's default heading). */
  headings: Record<string, string>;
  /** Block id → config (custom-text: { text }, photo blocks: { columns }). */
  config: Record<string, Record<string, unknown>>;
};

export const DEFAULT_LAYOUT: TemplateLayout = { order: [], hidden: [], headings: {}, config: {} };

/** Normalize untrusted layout JSON into a safe shape (unknown ids dropped,
 *  strings bounded). Never throws. */
export function sanitizeLayout(input: unknown, type: TemplateType): TemplateLayout {
  const raw = (input ?? {}) as Partial<TemplateLayout>;
  const known = new Set(BLOCK_META[type].map((b) => b.id));
  const order = Array.isArray(raw.order) ? raw.order.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
  const hidden = Array.isArray(raw.hidden) ? raw.hidden.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
  const headings: Record<string, string> = {};
  if (raw.headings && typeof raw.headings === "object") {
    for (const [id, v] of Object.entries(raw.headings)) {
      if (known.has(id) && typeof v === "string") headings[id] = v.slice(0, 60);
    }
  }
  const config: Record<string, Record<string, unknown>> = {};
  if (raw.config && typeof raw.config === "object") {
    for (const [id, v] of Object.entries(raw.config)) {
      if (known.has(id) && v && typeof v === "object" && !Array.isArray(v)) {
        const entry: Record<string, unknown> = {};
        const allowed = BLOCK_META[type].find((b) => b.id === id)?.config ?? [];
        for (const key of allowed) {
          if (key in (v as Record<string, unknown>)) entry[key] = (v as Record<string, unknown>)[key];
        }
        if (Object.keys(entry).length > 0) config[id] = entry;
      }
    }
  }
  // Dedupe order while preserving sequence.
  const seen = new Set<string>();
  const deduped = order.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  return { order: deduped, hidden: hidden.filter((id) => !deduped.includes(id)), headings, config };
}

// ── validation (§14) ────────────────────────────────────────────────────────

export type TemplateValidation = { ok: boolean; errors: string[]; warnings: string[] };

export function validateTemplate(type: TemplateType, layout: TemplateLayout, style: TemplateStyle): TemplateValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const meta = BLOCK_META[type];

  const required = meta.filter((b) => b.required);
  for (const b of required) {
    if (!layout.order.includes(b.id)) {
      errors.push(`Required block "${b.label}" is missing from the layout — it must stay in the document.`);
    }
  }
  if (layout.hidden.some((id) => meta.find((b) => b.id === id)?.required)) {
    errors.push("A required block (QR verification) cannot be hidden.");
  }
  if (layout.order.length === 0) {
    errors.push("The layout is empty — include at least one content block.");
  }

  // Custom text blocks must carry text and only catalog variables (§14/§46).
  for (const id of layout.order) {
    const cfg = layout.config[id] ?? {};
    if (cfg.text !== undefined) {
      const text = String(cfg.text ?? "").trim();
      if (!text) errors.push(`Custom Text block is in the layout but has no text — remove it or write content.`);
      for (const key of extractVarKeys(String(cfg.text ?? ""))) {
        if (!TEMPLATE_VARIABLES[type].some((v) => v.key === key)) {
          errors.push(`Unknown variable {{${key}}} in Custom Text — use the Insert Field picker to pick valid fields.`);
        }
      }
    }
    const cols = cfg.columns;
    if (cols !== undefined && !["1", "2", "3", 1, 2, 3, 4].includes(cols as string | number)) {
      errors.push(`Invalid photo grid column count on "${meta.find((b) => b.id === id)?.label ?? id}".`);
    }
  }

  // Hidden blocks that render nothing when data is absent are fine; warn when
  // an administrator hides core identity blocks.
  for (const id of layout.hidden) {
    const label = meta.find((b) => b.id === id)?.label ?? id;
    warnings.push(`"${label}" is hidden — it will not appear on generated documents.`);
  }

  // Style readability (§16).
  warnings.push(...styleReadabilityWarnings(style));

  return { ok: errors.length === 0, errors, warnings };
}
