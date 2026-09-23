// MOHD.HMS ENTERPRISE — Domain constants (shared, client-safe)

// ── Localization (§26 centralized application settings) ──
// The business locale is fixed to Brunei Darussalam. Do not switch the
// business currency based on browser location. BND is authoritative.
export const LOCALIZATION = {
  country: "Brunei Darussalam",
  countryCode: "BN",
  currencyCode: "BND",
  currencySymbol: "B$",
  locale: "en-BN",
  timezone: "Asia/Brunei",
  phoneCode: "+673",
} as const;

export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  SUPERVISOR: "SUPERVISOR",
  TECHNICIAN: "TECHNICIAN",
  CUSTOMER: "CUSTOMER",
  FINANCE: "FINANCE",
  HR: "HR",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
export const ALL_ROLES = Object.values(ROLES) as Role[];

export const PERMISSIONS = {
  // users
  users_read: "users.read",
  users_create: "users.create",
  users_update: "users.update",
  users_delete: "users.delete",
  // customers
  customers_read: "customers.read",
  customers_create: "customers.create",
  customers_update: "customers.update",
  customers_delete: "customers.delete",
  // employees / HR
  employees_read: "employees.read",
  employees_create: "employees.create",
  employees_update: "employees.update",
  employees_delete: "employees.delete",
  hr_read: "hr.read",
  hr_manage: "hr.manage",
  // HR letters (enterprise letter template + generation system)
  letters_view: "letters.view",
  letters_create: "letters.create",
  letters_edit: "letters.edit",
  letters_ai: "letters.ai",
  letters_approve: "letters.approve",
  letters_finalize: "letters.finalize",
  letters_send: "letters.send",
  letters_delete: "letters.delete",
  letters_templates: "letters.templates",
  // equipment
  equipment_read: "equipment.read",
  equipment_create: "equipment.create",
  equipment_update: "equipment.update",
  equipment_delete: "equipment.delete",
  // complaints
  complaints_read: "complaints.read",
  complaints_create: "complaints.create",
  complaints_assign: "complaints.assign",
  complaints_update: "complaints.update",
  complaints_close: "complaints.close",
  // Complaint Work Catalogue master data (§12/§13) — manage catalogues + their
  // catalogue-specific issue lists. Read side is public to complaints_create holders.
  catalogue_manage: "catalogue.manage",
  // work orders
  work_orders_read: "work_orders.read",
  work_orders_create: "work_orders.create",
  work_orders_assign: "work_orders.assign",
  work_orders_update: "work_orders.update",
  work_orders_complete: "work_orders.complete",
  // pm
  pm_read: "pm.read",
  pm_manage: "pm.manage",
  pm_execute: "pm.execute",
  pm_approve: "pm.approve", // PM §25/§72 — review/approve/close completed PM occurrences
  pm_report: "pm.report", // PM §55–§57 — compliance/performance/cost reports + export
  // centralized checklist engine (AI checklist spec §50) — uses the existing RBAC,
  // no separate permission system. Execution itself stays behind work_orders perms.
  checklist_view: "checklist.view", // view checklist instances / review page (customer: own, sanitized)
  checklist_generate: "checklist.generate", // AI ASSIST / template generation of drafts
  checklist_edit: "checklist.edit", // edit draft items (add/remove/reorder) before approval
  checklist_approve: "checklist.approve", // approve / reject / activate / attach checklists
  checklist_template_manage: "checklist.template_manage", // central template library CRUD + AI log
  // inventory
  inventory_read: "inventory.read",
  inventory_manage: "inventory.manage",
  // Inventory spec §42/§56/§71 — issue/return stock (supervisors+); technicians
  // may REQUEST materials but never directly move stock without authorization.
  inventory_issue: "inventory.issue",
  // Inventory spec §31/§32 — approve stock counts / authorized adjustments (admins only).
  inventory_adjust: "inventory.adjust",
  // purchases
  purchases_read: "purchases.read",
  purchases_manage: "purchases.manage",
  purchases_approve: "purchases.approve",
  // quotations
  quotations_read: "quotations.read",
  quotations_manage: "quotations.manage",
  // invoices
  invoices_read: "invoices.read",
  invoices_manage: "invoices.manage",
  // payments / finance
  payments_read: "payments.read",
  payments_record: "payments.record",
  finance_read: "finance.read",
  finance_manage: "finance.manage",
  // technician skills (spec §6-§8) — supervisors/admins manage technician skills
  technicians_manage: "technicians.manage",
  // IRMS
  irms_read: "irms.read",
  irms_create: "irms.create",
  irms_manage: "irms.manage",
  irms_portal: "irms.portal", // customer portal: view approved/shared inspection reports only
  // reports
  reports_read: "reports.read",
  reports_export: "reports.export",
  // settings & audit
  settings_read: "settings.read",
  settings_manage: "settings.manage",
  audit_read: "audit.read",
  // email automation + configuration (centralized EmailService admin area)
  email_view: "email.view", // access the email admin area, logs and health
  email_config: "email.config", // SMTP configuration edit + test connection/send
  email_templates: "email.templates", // template create/edit/publish/duplicate/test
  email_automations: "email.automations", // automation create/edit/enable/disable
  email_actions: "email.actions", // retry/cancel queued or failed emails
  // Email CLIENT (user-facing mailboxes) — the /email client for mailbox
  // members. Separate from email.view/email.config: seeing the client never
  // grants any infrastructure configuration rights (§36/§37). Actual use
  // additionally requires an ASSIGNED mailbox (MailboxMember/owner).
  email_client: "email.client",
  // WhatsApp automation + configuration (OpenWA gateway admin area)
  whatsapp_view: "whatsapp.view", // access the WhatsApp admin area + inbox
  whatsapp_config: "whatsapp.config", // gateway connection configuration edit
  whatsapp_connect: "whatsapp.connect", // connect/disconnect/reconnect session + QR
  whatsapp_send: "whatsapp.send", // send/reply/test messages
  whatsapp_templates: "whatsapp.templates", // template create/edit/version
  whatsapp_automations: "whatsapp.automations", // automation create/edit/enable/disable
  whatsapp_actions: "whatsapp.actions", // retry/cancel queued or failed messages
  // Push notifications (FCM) — admin notification center + test sends
  push_view: "push.view", // view the push notification center (devices, queue, history)
  push_manage: "push.manage", // send test notifications / manage the push channel
  // vehicles
  vehicles_read: "vehicles.read",
  vehicles_manage: "vehicles.manage",
  // Payroll (under HR) — salary data is highly sensitive (spec §29/§30):
  // read = view runs/dashboard, manage = prepare/calculate/adjust (HR),
  // approve = review/approve/finalize/mark-paid (Finance + admins).
  // Employees always see ONLY their own payslips via the self-service route
  // (ownership enforced server-side; needs no permission).
  payroll_read: "payroll.read",
  payroll_manage: "payroll.manage",
  payroll_approve: "payroll.approve",
  // Files (centralized private file management) — read/create/update/delete/
  // share are PERSONAL-space permissions granted to every role (each user
  // manages their own files; object-level authorization + sharing govern
  // access to OTHERS' files — role permissions are the coarse gate only).
  // manage_storage/audit are ADMIN/SUPER_ADMIN capabilities.
  files_read: "files.read",
  files_create: "files.create",
  files_update: "files.update",
  files_delete: "files.delete",
  files_share: "files.share",
  files_manage_storage: "files.manage_storage",
  files_audit: "files.audit",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ADMIN_PERMS: Permission[] = Object.values(PERMISSIONS);

const SUPERVISOR_PERMS: Permission[] = [
  PERMISSIONS.users_read,
  PERMISSIONS.customers_read,
  PERMISSIONS.employees_read,
  PERMISSIONS.equipment_read, PERMISSIONS.equipment_create, PERMISSIONS.equipment_update,
  // Technician skills (spec §6-§8) — supervisors manage their team's skills
  PERMISSIONS.technicians_manage,
  // WhatsApp inbox access (conversation view + replies; no gateway config)
  PERMISSIONS.whatsapp_view, PERMISSIONS.whatsapp_send,
  // Email client — mailbox members only (assignment enforced per-user)
  PERMISSIONS.email_client,
  PERMISSIONS.complaints_read, PERMISSIONS.complaints_create, PERMISSIONS.complaints_assign, PERMISSIONS.complaints_update, PERMISSIONS.complaints_close,
  PERMISSIONS.catalogue_manage,
  PERMISSIONS.work_orders_read, PERMISSIONS.work_orders_create, PERMISSIONS.work_orders_assign, PERMISSIONS.work_orders_update, PERMISSIONS.work_orders_complete,
  PERMISSIONS.pm_read, PERMISSIONS.pm_manage, PERMISSIONS.pm_approve, PERMISSIONS.pm_report,
  // Checklist engine — supervisors generate/review/approve; templates are managed here too
  PERMISSIONS.checklist_view, PERMISSIONS.checklist_generate, PERMISSIONS.checklist_edit,
  PERMISSIONS.checklist_approve, PERMISSIONS.checklist_template_manage,
  PERMISSIONS.inventory_read, PERMISSIONS.inventory_issue,
  PERMISSIONS.purchases_read,
  PERMISSIONS.quotations_read, PERMISSIONS.quotations_manage,
  PERMISSIONS.invoices_read,
  PERMISSIONS.irms_read, PERMISSIONS.irms_create, PERMISSIONS.irms_manage,
  PERMISSIONS.reports_read, PERMISSIONS.reports_export,
  PERMISSIONS.vehicles_read, PERMISSIONS.vehicles_manage,
  // Files — personal file manager for every staff role (spec §31/§34)
  PERMISSIONS.files_read, PERMISSIONS.files_create, PERMISSIONS.files_update,
  PERMISSIONS.files_delete, PERMISSIONS.files_share,
];

const TECHNICIAN_PERMS: Permission[] = [
  PERMISSIONS.equipment_read,
  PERMISSIONS.complaints_read, PERMISSIONS.complaints_update,
  PERMISSIONS.work_orders_read, PERMISSIONS.work_orders_update, PERMISSIONS.work_orders_complete,
  PERMISSIONS.pm_read, PERMISSIONS.pm_execute, PERMISSIONS.pm_report,
  // Checklist engine — technicians see assigned checklists and execute them (spec §53)
  PERMISSIONS.checklist_view,
  PERMISSIONS.inventory_read,
  PERMISSIONS.irms_read, PERMISSIONS.irms_create,
  // Email client — mailbox members only (assignment enforced per-user)
  PERMISSIONS.email_client,
  PERMISSIONS.files_read, PERMISSIONS.files_create, PERMISSIONS.files_update,
  PERMISSIONS.files_delete, PERMISSIONS.files_share,
];

const CUSTOMER_PERMS: Permission[] = [
  PERMISSIONS.equipment_read,
  PERMISSIONS.complaints_read, PERMISSIONS.complaints_create,
  PERMISSIONS.work_orders_read,
  PERMISSIONS.invoices_read,
  PERMISSIONS.quotations_read,
  PERMISSIONS.irms_portal,
  // PM §44 — customers see the PM schedule/history of THEIR equipment only
  // (scoping enforced per-route; internal financials/notes stripped in APIs).
  PERMISSIONS.pm_read,
  // Checklist engine §52 — customers see only their own checklists/results,
  // sanitized (no technician notes / AI metadata / approval internals).
  PERMISSIONS.checklist_view,
  // Files §33 — customers manage their OWN private files + shared-with-them;
  // administrative Files features stay behind files.manage_storage/audit.
  PERMISSIONS.files_read, PERMISSIONS.files_create, PERMISSIONS.files_update,
  PERMISSIONS.files_delete, PERMISSIONS.files_share,
];

const FINANCE_PERMS: Permission[] = [
  PERMISSIONS.customers_read,
  PERMISSIONS.quotations_read,
  PERMISSIONS.invoices_read, PERMISSIONS.invoices_manage,
  PERMISSIONS.payments_read, PERMISSIONS.payments_record,
  PERMISSIONS.finance_read, PERMISSIONS.finance_manage,
  PERMISSIONS.purchases_read, PERMISSIONS.purchases_approve,
  // Inventory spec §56 — Finance views costing/stock valuation (read-only).
  PERMISSIONS.inventory_read,
  PERMISSIONS.reports_read, PERMISSIONS.reports_export,
  // Payroll (spec §29) — Finance reviews, approves and marks payment;
  // preparation stays with HR (segregation of duties).
  PERMISSIONS.payroll_read, PERMISSIONS.payroll_approve,
  // Email client — mailbox members only (assignment enforced per-user)
  PERMISSIONS.email_client,
  PERMISSIONS.files_read, PERMISSIONS.files_create, PERMISSIONS.files_update,
  PERMISSIONS.files_delete, PERMISSIONS.files_share,
];

const HR_PERMS: Permission[] = [
  PERMISSIONS.users_read,
  PERMISSIONS.employees_read, PERMISSIONS.employees_create, PERMISSIONS.employees_update,
  PERMISSIONS.hr_read, PERMISSIONS.hr_manage,
  PERMISSIONS.reports_read, PERMISSIONS.reports_export,
  // HR letters — HR prepares, generates AI drafts and manages templates;
  // approval stays with ADMIN/SUPER_ADMIN (segregation of duties, spec §16).
  PERMISSIONS.letters_view, PERMISSIONS.letters_create, PERMISSIONS.letters_edit,
  PERMISSIONS.letters_ai, PERMISSIONS.letters_templates, PERMISSIONS.letters_finalize,
  PERMISSIONS.letters_send, PERMISSIONS.letters_delete,
  // Payroll (spec §28/§29) — HR prepares, calculates and adjusts payroll;
  // approval stays with FINANCE/ADMIN (segregation of duties, spec §28).
  PERMISSIONS.payroll_read, PERMISSIONS.payroll_manage,
  // Email client — mailbox members only (assignment enforced per-user)
  PERMISSIONS.email_client,
  PERMISSIONS.files_read, PERMISSIONS.files_create, PERMISSIONS.files_update,
  PERMISSIONS.files_delete, PERMISSIONS.files_share,
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ADMIN_PERMS,
  ADMIN: ADMIN_PERMS,
  SUPERVISOR: SUPERVISOR_PERMS,
  TECHNICIAN: TECHNICIAN_PERMS,
  CUSTOMER: CUSTOMER_PERMS,
  FINANCE: FINANCE_PERMS,
  HR: HR_PERMS,
};

// ── Complaint workflow ──
export const COMPLAINT_STATUSES = ["NEW", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CONFIRMED", "CLOSED", "CANCELLED"] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const COMPLAINT_TRANSITIONS: Record<string, string[]> = {
  NEW: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: ["CONFIRMED"],
  CONFIRMED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

// ── IRMS inspection report workflow (spec §29) ──
export const IRMS_STATUSES = ["DRAFT", "SUBMITTED", "IN_REVIEW", "MANAGER_APPROVAL", "CLIENT_REVIEW", "APPROVED", "REJECTED", "ARCHIVED"] as const;
export type IrmsStatus = (typeof IRMS_STATUSES)[number];
export const IRMS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["IN_REVIEW", "REJECTED"],
  IN_REVIEW: ["MANAGER_APPROVAL", "REJECTED"],
  MANAGER_APPROVAL: ["CLIENT_REVIEW", "APPROVED", "REJECTED"],
  CLIENT_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["ARCHIVED"],
  REJECTED: ["DRAFT"],
  ARCHIVED: [],
};
export const IRMS_PHOTO_CATEGORIES = ["BEFORE", "AFTER", "PROGRESS", "DURING", "INSPECTION", "COMPLETION", "DEFECT", "EVIDENCE"] as const;
export const IRMS_PHOTO_PREFIX: Record<string, string> = {
  BEFORE: "B", AFTER: "A", PROGRESS: "P", DURING: "D", INSPECTION: "I", COMPLETION: "C", DEFECT: "F", EVIDENCE: "E",
};
export const IRMS_SIGNATURE_ROLES = ["INSPECTOR", "SUPERVISOR", "MANAGER", "CLIENT"] as const;

export const WO_STATUSES = ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;
export const WO_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["IN_PROGRESS", "ON_HOLD", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "ON_HOLD"],
  ON_HOLD: ["IN_PROGRESS", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const INVOICE_STATUSES = ["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"] as const;
export const QUOTATION_STATUSES = ["DRAFT", "SENT", "APPROVED", "REJECTED", "EXPIRED", "CONVERTED"] as const;
export const PO_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"] as const;

// ── Inventory spec §3/§12/§28/§29 — canonical item taxonomy, material states, UOMs ──
export const ITEM_TYPES = [
  "STOCK", "SPARE_PART", "CONSUMABLE", "MATERIAL", "TOOL", "EQUIPMENT_COMPONENT", "SERVICE", "NON_STOCK", "ASSET",
] as const;
/** Item types that never hold stock (§3 — do not make every quotation line stockable). */
export const NON_STOCK_ITEM_TYPES = ["SERVICE", "NON_STOCK"] as const;
export const WO_MATERIAL_STATUSES = ["REQUESTED", "RESERVED", "ISSUED", "USED", "RETURNED", "CANCELLED"] as const;
export const STOCK_MOVEMENT_TYPES = [
  "OPENING", "RECEIVE", "ISSUE", "RETURN", "ADJUST", "TRANSFER_OUT", "TRANSFER_IN", "DAMAGE", "LOSS", "STOCK_COUNT",
] as const;
/** §29 — one canonical UOM set. Free-text units are normalized to upper-case of this list when matched. */
export const UOMS = ["PCS", "EA", "SET", "BOX", "M", "M2", "M3", "KG", "L", "ROLL", "PACK", "UNIT", "HR"] as const;
/** §28 — suggested categories (configurable; the inventory module also accepts free text). */
export const INVENTORY_CATEGORIES = [
  "HVAC", "ELECTRICAL", "PLUMBING", "FIRE_PROTECTION", "GENERATOR", "MECHANICAL", "CIVIL",
  "CLEANING", "PEST_CONTROL", "LANDSCAPE", "GENERAL", "TOOLS", "CONSUMABLES", "SPARE_PARTS",
] as const;

export function normalizeUom(unit: string | undefined | null): string {
  const u = (unit ?? "").trim().toUpperCase();
  if (!u) return "PCS";
  const aliases: Record<string, string> = { METRE: "M", METER: "M", METERS: "M", METRES: "M", MTR: "M", LTR: "L", LITRE: "L", LITER: "L", PIECE: "PCS", PIECES: "PCS", PC: "PCS", HRS: "HR", HOUR: "HR", HOURS: "HR", EACH: "EA", SQM: "M2", CBM: "M3" };
  if (aliases[u]) return aliases[u];
  if ((UOMS as readonly string[]).includes(u)) return u;
  return u; // unknown units pass through upper-cased (never silently renamed)
}

export const PM_FREQUENCIES = [
  "DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "EVERY_2_MONTHS", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL", "CUSTOM",
] as const;

// PM §6 — plan types. METER/USAGE/RUNTIME run on the meter engine, the rest on
// the calendar engine (CONDITION/SEASONAL/INSPECTION are calendar cadences with
// condition-oriented checklists).
export const PM_PLAN_TYPES = ["CALENDAR", "METER", "USAGE", "RUNTIME", "CONDITION", "SEASONAL", "INSPECTION"] as const;
export const PM_METER_PLAN_TYPES = ["METER", "USAGE", "RUNTIME"] as const;
export const PM_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const PM_CHECKLIST_RESPONSE_TYPES = ["CHECKBOX", "PASSFAIL", "YESNO", "NUMERIC", "TEXT"] as const;
export const PM_FINDING_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const PM_PHOTO_PHASES = ["BEFORE", "DURING", "AFTER", "FINDING", "METER"] as const;
export const PM_TASK_STATUSES = ["SCHEDULED", "OVERDUE", "IN_PROGRESS", "COMPLETED", "SKIPPED", "CANCELLED", "FAILED"] as const;

// ── Centralized checklist engine (AI checklist spec) ──
export const CHECKLIST_SOURCE_TYPES = ["COMPLAINT", "WORK_ORDER", "PM", "IRMS"] as const;
export type ChecklistSourceType = (typeof CHECKLIST_SOURCE_TYPES)[number];
export const CHECKLIST_ORIGINS = ["AI", "TEMPLATE", "MANUAL", "HYBRID"] as const;
// Lifecycle §4 — AI GENERATED → DRAFT → APPROVED → ACTIVE → COMPLETED (→ ARCHIVED)
export const CHECKLIST_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "ACTIVE", "COMPLETED", "ARCHIVED"] as const;
export const CHECKLIST_TASK_PRIORITIES = ["ROUTINE", "IMPORTANT", "SAFETY", "CRITICAL"] as const;
export const CHECKLIST_WORK_TYPES = [
  "PREVENTIVE", "CORRECTIVE", "TROUBLESHOOTING", "INSPECTION", "COMMISSIONING", "INSTALLATION", "GENERAL",
] as const;
// The execution surface supports these five response types (shared with PM §17);
// the AI's richer vocabulary is deterministically mapped onto them by the validator.
export const CHECKLIST_RESPONSE_TYPES = PM_CHECKLIST_RESPONSE_TYPES;
// PM §15/§54 — standard template-library categories (PmTemplate.category)
export const PM_TEMPLATE_CATEGORIES = [
  "HVAC", "ELECTRICAL", "PLUMBING", "FIRE_PROTECTION", "GENERATOR", "LIFT", "BUILDING",
  "CIVIL", "MECHANICAL", "PEST_CONTROL", "CLEANING", "LANDSCAPE", "GENERAL",
] as const;

// ── HR letter workflow (spec §16) ──
// DRAFT — being prepared · AI_GENERATED — AI draft awaiting human review ·
// UNDER_REVIEW — submitted for approval · APPROVED — approved, ready to finalize ·
// REJECTED — sent back for changes · FINALIZED — immutable final PDF stored ·
// SENT — emailed/shared · ARCHIVED — closed.
export const LETTER_STATUSES = ["DRAFT", "AI_GENERATED", "UNDER_REVIEW", "APPROVED", "REJECTED", "FINALIZED", "SENT", "ARCHIVED"] as const;
export type LetterStatus = (typeof LETTER_STATUSES)[number];
export const LETTER_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["AI_GENERATED", "UNDER_REVIEW"],
  AI_GENERATED: ["UNDER_REVIEW", "DRAFT"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  REJECTED: ["DRAFT", "UNDER_REVIEW"],
  APPROVED: ["FINALIZED"],
  FINALIZED: ["SENT", "ARCHIVED"],
  SENT: ["ARCHIVED"],
  ARCHIVED: [],
};

export const FREQUENCY_DAYS: Record<string, number> = {
  WEEKLY: 7,
  MONTHLY: 30,
  QUARTERLY: 90,
  SEMI_ANNUAL: 182,
  ANNUAL: 365,
};

// Safe: statuses the UI can render with a color token
export const STATUS_TONE: Record<string, string> = {
  NEW: "bg-emerald-100 text-emerald-800",
  ASSIGNED: "bg-teal-100 text-teal-800",
  IN_PROGRESS: "bg-amber-100 text-amber-800",
  COMPLETED: "bg-lime-100 text-lime-800",
  CONFIRMED: "bg-green-100 text-green-800",
  CLOSED: "bg-stone-200 text-stone-700",
  CANCELLED: "bg-red-100 text-red-700",
  REJECTED: "bg-red-100 text-red-700",
  PENDING: "bg-amber-100 text-amber-800",
  PENDING_APPROVAL: "bg-amber-100 text-amber-800",
  ACCEPTED: "bg-teal-100 text-teal-800",
  ON_HOLD: "bg-orange-100 text-orange-800",
  ACTIVE: "bg-emerald-100 text-emerald-800",
  INACTIVE: "bg-stone-200 text-stone-600",
  DISABLED: "bg-red-100 text-red-700",
  DRAFT: "bg-stone-200 text-stone-700",
  SENT: "bg-teal-100 text-teal-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  PARTIALLY_PAID: "bg-amber-100 text-amber-800",
  PAID: "bg-emerald-100 text-emerald-800",
  OVERDUE: "bg-red-100 text-red-700",
  EXPIRED: "bg-stone-200 text-stone-600",
  CONVERTED: "bg-green-100 text-green-800",
  RECEIVED: "bg-emerald-100 text-emerald-800",
  PARTIALLY_RECEIVED: "bg-amber-100 text-amber-800",
  SCHEDULED: "bg-teal-100 text-teal-800",
  SKIPPED: "bg-stone-200 text-stone-600",
  AVAILABLE: "bg-emerald-100 text-emerald-800",
  ON_JOB: "bg-amber-100 text-amber-800",
  OFF_DUTY: "bg-stone-200 text-stone-600",
  UNDER_MAINTENANCE: "bg-amber-100 text-amber-800",
  RETIRED: "bg-stone-200 text-stone-600",
  IN_USE: "bg-amber-100 text-amber-800",
  MAINTENANCE: "bg-amber-100 text-amber-800",
  SUBMITTED: "bg-teal-100 text-teal-800",
  LOW: "bg-stone-200 text-stone-700",
  MEDIUM: "bg-amber-100 text-amber-800",
  HIGH: "bg-orange-100 text-orange-800",
  URGENT: "bg-red-100 text-red-700",
  CRITICAL: "bg-red-100 text-red-700",
  GOOD: "bg-emerald-100 text-emerald-800",
  EXCELLENT: "bg-emerald-100 text-emerald-800",
  FAIR: "bg-amber-100 text-amber-800",
  POOR: "bg-orange-100 text-orange-800",
  PRESENT: "bg-emerald-100 text-emerald-800",
  ABSENT: "bg-red-100 text-red-700",
  LEAVE: "bg-amber-100 text-amber-800",
  HALF_DAY: "bg-amber-100 text-amber-800",
  ON_LEAVE: "bg-amber-100 text-amber-800",
  TERMINATED: "bg-red-100 text-red-700",
  PLANNING: "bg-stone-200 text-stone-600",
  ANNUAL: "bg-teal-100 text-teal-800",
  SICK: "bg-orange-100 text-orange-800",
  UNPAID: "bg-stone-200 text-stone-600",
  OTHER: "bg-stone-200 text-stone-600",
  AI_GENERATED: "bg-violet-100 text-violet-800",
  // checklist engine lifecycle tones (spec §4/§64)
  HYBRID: "bg-violet-100 text-violet-800",
  TEMPLATE: "bg-teal-100 text-teal-800",
  MANUAL: "bg-stone-200 text-stone-700",
  UNDER_REVIEW: "bg-amber-100 text-amber-800",
  FINALIZED: "bg-emerald-100 text-emerald-800",
  ARCHIVED: "bg-stone-200 text-stone-600",
  // payment-proof workflow (spec §20-§30)
  RECORDED: "bg-teal-100 text-teal-800",
  PAYMENT_ON_HOLD: "bg-orange-100 text-orange-800",
  MATCHED: "bg-emerald-100 text-emerald-800",
  MISMATCH: "bg-red-100 text-red-700",
  UNVERIFIED: "bg-stone-200 text-stone-700",
  // petty cash (spec §31-§41)
  CASH_IN: "bg-emerald-100 text-emerald-800",
  CASH_OUT: "bg-orange-100 text-orange-800",
  TOP_UP: "bg-teal-100 text-teal-800",
  EXPENSE: "bg-amber-100 text-amber-800",
  REIMBURSEMENT: "bg-violet-100 text-violet-800",
  ADJUSTMENT: "bg-stone-200 text-stone-700",
  FLAGGED: "bg-red-100 text-red-700",
  RECONCILED: "bg-emerald-100 text-emerald-800",
  LOCKED: "bg-red-100 text-red-700",
};

export function humanize(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
