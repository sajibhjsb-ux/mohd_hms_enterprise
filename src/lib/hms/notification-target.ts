// MOHD.HMS ENTERPRISE — canonical Notification resource → SPA page resolver.
// Pure (no browser/server-only imports) so the header dropdown and the push
// pipeline share one mapping. Unknown types return null; the caller marks the
// notification read without navigating.

export type NotificationTarget = {
  module: string;
  seg: string[];
  query?: Record<string, string>;
};

type RouteDef = {
  module: string;
  seg?: (id: string) => string[];
  query?: (id: string) => Record<string, string>;
  /** Route does not depend on the record id (self-service / list pages). */
  idless?: boolean;
};

const ROUTES: Record<string, RouteDef> = {
  COMPLAINT: { module: "complaints", seg: (id) => [id] },
  WORK_ORDER: { module: "work-orders", seg: (id) => [id] },
  EQUIPMENT: { module: "equipment", seg: (id) => [id] },
  CUSTOMER: { module: "customers", seg: (id) => [id] },
  INVOICE: { module: "invoices", seg: (id) => [id] },
  PAYMENT: { module: "invoices", seg: (id) => [id] },
  QUOTATION: { module: "quotations", seg: (id) => [id] },
  PURCHASE_ORDER: { module: "purchases", seg: (id) => [id] },
  INVENTORY_ITEM: { module: "inventory", query: (id) => ({ view: "items", focus: id }) },
  INSPECTION_REPORT: { module: "irms", seg: (id) => ["reports", id] },
  CHECKLIST_INSTANCE: { module: "checklists", seg: (id) => [id] },
  PM_TASK: { module: "pm", seg: (id) => ["tasks", id] },
  PM_PLAN: { module: "pm", seg: (id) => ["plans", id] },
  // Legacy finding notifications carry the finding id; findings live on the
  // plans workspace, so land there rather than on a nonexistent detail page.
  PM_FINDING: { module: "pm", query: () => ({ tab: "plans" }), idless: true },
  PAYROLL_RUN: { module: "hr", seg: (id) => ["payroll", id] },
  PAYROLL_ITEM: { module: "profile", idless: true },
  PAYROLL_ADJUSTMENT: { module: "hr", seg: () => ["payroll"], idless: true },
  OVERTIME_REQUEST: { module: "hr", query: () => ({ tab: "overtime" }), idless: true },
  LEAVE_REQUEST: { module: "hr", query: () => ({ tab: "leave" }), idless: true },
  LETTER: { module: "hr", seg: (id) => ["letters", id] },
  USER: { module: "profile", idless: true },
  USER_DIRECTORY: { module: "users", seg: (id) => [id] },
  PHONE_REQUEST_REVIEW: { module: "users", idless: true },
  SESSION: { module: "profile", idless: true },
  PROFILE_CHANGE_REQUEST: { module: "profile", idless: true },
  WHATSAPP_CONVERSATION: { module: "whatsapp", seg: (id) => [id] },
  MAIL_MESSAGE: { module: "email", seg: (id) => ["m", id] },
  FILE: { module: "files", seg: (id) => ["file", id] },
  FILE_FOLDER: { module: "files", seg: (id) => ["my", id] },
  MAILBOX: { module: "email", idless: true },
};

/** Legacy/inconsistent casing used by older notify() call sites. */
const ALIASES: Record<string, string> = {
  WORKORDER: "WORK_ORDER",
  PURCHASEORDER: "PURCHASE_ORDER",
  INVENTORYITEM: "INVENTORY_ITEM",
  INSPECTIONREPORT: "INSPECTION_REPORT",
  CHECKLISTINSTANCE: "CHECKLIST_INSTANCE",
  PMTASK: "PM_TASK",
  PMPLAN: "PM_PLAN",
  PAYROLLRUN: "PAYROLL_RUN",
  PAYROLLITEM: "PAYROLL_ITEM",
  PAYROLLADJUSTMENT: "PAYROLL_ADJUSTMENT",
  OVERTIMEREQUEST: "OVERTIME_REQUEST",
  LEAVEREQUEST: "LEAVE_REQUEST",
  HR_LEAVE: "LEAVE_REQUEST",
  PROFILECHANGEREQUEST: "PROFILE_CHANGE_REQUEST",
  MAILMESSAGE: "MAIL_MESSAGE",
  FILEFOLDER: "FILE_FOLDER",
  WHATSAPPCONVERSATION: "WHATSAPP_CONVERSATION",
};

export function notificationTarget(
  resourceType?: string | null,
  resourceId?: string | null
): NotificationTarget | null {
  const type = (resourceType ?? "").trim().toUpperCase();
  if (!type) return null;
  const key = ALIASES[type] ?? type;
  const route = ROUTES[key];
  if (!route) return null;
  const id = (resourceId ?? "").trim();
  if (!id && !route.idless) return null;
  return {
    module: route.module,
    seg: route.seg ? route.seg(id) : [],
    ...(route.query ? { query: route.query(id) } : {}),
  };
}

/** Absolute app path for push payloads (relative to the app origin). */
export function notificationHref(
  resourceType?: string | null,
  resourceId?: string | null
): string {
  const target = notificationTarget(resourceType, resourceId);
  if (!target) return "/dashboard";
  const path = target.seg.length
    ? `/${target.module}/${target.seg.map(encodeURIComponent).join("/")}`
    : `/${target.module}`;
  const query = target.query ? new URLSearchParams(target.query).toString() : "";
  return query ? `${path}?${query}` : path;
}
