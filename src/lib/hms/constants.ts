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
  // inventory
  inventory_read: "inventory.read",
  inventory_manage: "inventory.manage",
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
  // vehicles
  vehicles_read: "vehicles.read",
  vehicles_manage: "vehicles.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ADMIN_PERMS: Permission[] = Object.values(PERMISSIONS);

const SUPERVISOR_PERMS: Permission[] = [
  PERMISSIONS.users_read,
  PERMISSIONS.customers_read,
  PERMISSIONS.employees_read,
  PERMISSIONS.equipment_read, PERMISSIONS.equipment_create, PERMISSIONS.equipment_update,
  PERMISSIONS.complaints_read, PERMISSIONS.complaints_create, PERMISSIONS.complaints_assign, PERMISSIONS.complaints_update, PERMISSIONS.complaints_close,
  PERMISSIONS.work_orders_read, PERMISSIONS.work_orders_create, PERMISSIONS.work_orders_assign, PERMISSIONS.work_orders_update, PERMISSIONS.work_orders_complete,
  PERMISSIONS.pm_read, PERMISSIONS.pm_manage,
  PERMISSIONS.inventory_read,
  PERMISSIONS.purchases_read,
  PERMISSIONS.quotations_read, PERMISSIONS.quotations_manage,
  PERMISSIONS.invoices_read,
  PERMISSIONS.irms_read, PERMISSIONS.irms_create, PERMISSIONS.irms_manage,
  PERMISSIONS.reports_read, PERMISSIONS.reports_export,
  PERMISSIONS.vehicles_read, PERMISSIONS.vehicles_manage,
];

const TECHNICIAN_PERMS: Permission[] = [
  PERMISSIONS.equipment_read,
  PERMISSIONS.complaints_read, PERMISSIONS.complaints_update,
  PERMISSIONS.work_orders_read, PERMISSIONS.work_orders_update, PERMISSIONS.work_orders_complete,
  PERMISSIONS.pm_read, PERMISSIONS.pm_execute,
  PERMISSIONS.inventory_read,
  PERMISSIONS.irms_read, PERMISSIONS.irms_create,
];

const CUSTOMER_PERMS: Permission[] = [
  PERMISSIONS.equipment_read,
  PERMISSIONS.complaints_read, PERMISSIONS.complaints_create,
  PERMISSIONS.work_orders_read,
  PERMISSIONS.invoices_read,
  PERMISSIONS.quotations_read,
  PERMISSIONS.irms_portal,
];

const FINANCE_PERMS: Permission[] = [
  PERMISSIONS.customers_read,
  PERMISSIONS.quotations_read,
  PERMISSIONS.invoices_read, PERMISSIONS.invoices_manage,
  PERMISSIONS.payments_read, PERMISSIONS.payments_record,
  PERMISSIONS.finance_read, PERMISSIONS.finance_manage,
  PERMISSIONS.purchases_read, PERMISSIONS.purchases_approve,
  PERMISSIONS.reports_read, PERMISSIONS.reports_export,
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
export const PM_FREQUENCIES = ["WEEKLY", "MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL"] as const;

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
  UNDER_REVIEW: "bg-amber-100 text-amber-800",
  FINALIZED: "bg-emerald-100 text-emerald-800",
  ARCHIVED: "bg-stone-200 text-stone-600",
};

export function humanize(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
