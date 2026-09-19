// MOHD.HMS ENTERPRISE — Template variable resolution (§10 DATA RESOLUTION).
// Variables are resolved SERVER-SIDE from authorized application data only —
// there is no path by which a caller can inject a query or an arbitrary value:
// the automation names the event, the resolver loads exactly the record the
// event points at, and every value is escaped before substitution (render.ts).
//
// Company/global variables come from the SAME canonical company settings the
// PDFs and header use (no second branding storage, §57).

import "server-only";
import { db } from "@/lib/db";
import { formatCurrency } from "@/lib/hms/format";
import { LOCALIZATION } from "@/lib/hms/constants";
import { getBranding } from "@/lib/hms/pdf/branding";

export type ResolutionContext = {
  eventType: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  /** Direct-send recipient user (OTP, generic notification). */
  user?: { id: string; email: string; name: string } | null;
  /** Direct-send extras (OTP code etc.). */
  extra?: Record<string, string>;
};

const dateStr = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: LOCALIZATION.timezone }).format(d) : "";
const money = (cents: number | null | undefined) => formatCurrency((cents ?? 0) / 100);

async function companyVars(): Promise<Record<string, string>> {
  const brand = await getBranding().catch(() => null);
  const site = await db.setting
    .findUnique({ where: { key: "public_url" } })
    .then((r) => r?.value ?? "")
    .catch(() => "");
  return {
    COMPANY_NAME: brand?.company || "MOHD.HMS Enterprise",
    COMPANY_ADDRESS: brand?.address || "",
    COMPANY_PHONE: brand?.phone || "",
    COMPANY_EMAIL: brand?.email || "",
    COMPANY_WEBSITE: site,
    // Email clients need an absolute URL; the sandbox default covers local testing.
    PORTAL_URL: site || process.env.APP_ORIGIN || "https://www.mohdhms.com",
    PORTAL_LINK_TEXT: "",
  };
}

/**
 * Resolve the variable map for a template key given the event/recipient context.
 * Unknown variables simply stay unresolved and are dropped by the renderer —
 * resolution NEVER throws (an email must never break the business flow).
 */
export async function resolveTemplateData(templateKey: string, ctx: ResolutionContext): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...(await companyVars()), ...(ctx.extra ?? {}) };

  if (ctx.user) {
    out.USER_NAME = ctx.user.name || "there";
    out.USER_EMAIL = ctx.user.email;
  }

  try {
    switch (templateKey) {
      // ── Complaints ──
      case "COMPLAINT_CREATED":
      case "COMPLAINT_ASSIGNED":
      case "COMPLAINT_COMPLETED": {
        const c = await db.complaint.findUnique({
          where: { id: ctx.resourceId },
          include: {
            customer: { select: { companyName: true, contactPerson: true } },
            equipment: { select: { location: { select: { name: true } } } },
            assignedTechnician: { select: { user: { select: { name: true } } } },
          },
        });
        if (!c) break;
        out.COMPLAINT_NUMBER = c.code;
        out.COMPLAINT_TITLE = c.title;
        out.COMPLAINT_PRIORITY = c.priority;
        out.COMPLAINT_STATUS = c.status;
        out.COMPLAINT_LOCATION = c.equipment?.location?.name ?? "";
        out.CUSTOMER_NAME = c.customer?.companyName || c.customer?.contactPerson || "";
        out.TECHNICIAN_NAME = c.assignedTechnician?.user?.name ?? "";
        break;
      }
      // ── Work orders ──
      case "WORK_ORDER_CREATED":
      case "WORK_ORDER_COMPLETED": {
        const w = await db.workOrder.findUnique({
          where: { id: ctx.resourceId },
          include: {
            customer: { select: { companyName: true, contactPerson: true } },
            complaint: { select: { code: true, title: true, equipment: { select: { location: { select: { name: true } } } } } },
            technician: { select: { user: { select: { name: true } } } },
          },
        });
        if (!w) break;
        out.WORK_ORDER_NUMBER = w.code;
        out.WORK_ORDER_TITLE = w.title;
        out.WORK_ORDER_PRIORITY = w.priority;
        out.WORK_ORDER_STATUS = w.status;
        out.WORK_ORDER_TOTAL = money(w.totalCents);
        out.COMPLAINT_LOCATION = w.complaint?.equipment?.location?.name ?? "";
        out.CUSTOMER_NAME = w.customer?.companyName || w.customer?.contactPerson || "";
        out.TECHNICIAN_NAME = w.technician?.user?.name ?? "";
        break;
      }
      // ── Quotations ──
      case "QUOTATION_SENT":
      case "QUOTATION_ACCEPTED":
      case "QUOTATION_EXPIRING": {
        const q = await db.quotation.findUnique({
          where: { id: ctx.resourceId },
          include: { customer: { select: { companyName: true, contactPerson: true } } },
        });
        if (!q) break;
        out.QUOTATION_NUMBER = q.code;
        out.QUOTATION_DATE = dateStr(q.quotationDate);
        out.QUOTATION_TOTAL = money(q.totalCents);
        out.QUOTATION_VALID_UNTIL = dateStr(q.validUntil);
        out.QUOTATION_STATUS = q.status;
        out.CUSTOMER_NAME = q.customer?.companyName || q.customer?.contactPerson || "";
        break;
      }
      // ── Invoices ──
      case "INVOICE_SENT":
      case "INVOICE_DUE_SOON":
      case "INVOICE_OVERDUE": {
        const inv = await db.invoice.findUnique({
          where: { id: ctx.resourceId },
          include: { customer: { select: { companyName: true, contactPerson: true } } },
        });
        if (!inv) break;
        out.INVOICE_NUMBER = inv.code;
        out.INVOICE_DATE = dateStr(inv.invoiceDate);
        out.INVOICE_DUE_DATE = dateStr(inv.dueDate);
        out.INVOICE_TOTAL = money(inv.totalCents);
        out.INVOICE_BALANCE = money(inv.balanceCents);
        out.INVOICE_STATUS = inv.status;
        out.CUSTOMER_NAME = inv.customer?.companyName || inv.customer?.contactPerson || "";
        break;
      }
      // ── Payments (event points at the invoice; most recent payment wins) ──
      case "PAYMENT_RECEIVED": {
        const inv = await db.invoice.findUnique({
          where: { id: ctx.resourceId },
          include: { customer: { select: { companyName: true, contactPerson: true } }, payments: { orderBy: { paidAt: "desc" }, take: 1 } },
        });
        if (!inv) break;
        const pay = inv.payments[0];
        out.PAYMENT_AMOUNT = money(Number(ctx.payload.amountCents ?? pay?.amountCents ?? 0));
        out.PAYMENT_DATE = dateStr(pay?.paidAt ?? new Date());
        out.INVOICE_NUMBER = inv.code;
        out.INVOICE_BALANCE = money(Number(ctx.payload.balanceCents ?? inv.balanceCents));
        out.CUSTOMER_NAME = inv.customer?.companyName || inv.customer?.contactPerson || "";
        break;
      }
      // ── PM (events point at the PM task) ──
      case "PM_REMINDER":
      case "PM_OVERDUE": {
        const t = await db.pmTask.findUnique({
          where: { id: ctx.resourceId },
          include: {
            plan: { select: { code: true, name: true } },
            equipment: { select: { name: true, assetTag: true } },
            technician: { select: { user: { select: { name: true } } } },
          },
        });
        if (!t) break;
        out.PM_PLAN_CODE = t.plan?.code ?? "";
        out.PM_PLAN_NAME = t.plan?.name ?? "";
        out.PM_DUE_DATE = dateStr(t.dueDate);
        out.EQUIPMENT_NAME = t.equipment ? `${t.equipment.name} (${t.equipment.assetTag})` : "";
        out.TECHNICIAN_NAME = t.technician?.user?.name ?? "";
        break;
      }
      // ── Purchases ──
      case "PURCHASE_CREATED":
      case "PURCHASE_RECEIVED": {
        const po = await db.purchaseOrder.findUnique({
          where: { id: ctx.resourceId },
          include: { supplier: { select: { name: true } } },
        });
        if (!po) break;
        out.PURCHASE_NUMBER = po.code;
        out.SUPPLIER_NAME = po.supplier?.name ?? "";
        out.PURCHASE_TOTAL = money(po.totalCents);
        out.PURCHASE_STATUS = po.status;
        break;
      }
      // ── IRMS inspection reports ──
      case "IRMS_REPORT_SUBMITTED":
      case "IRMS_REPORT_APPROVED": {
        const r = await db.inspectionReport.findUnique({
          where: { id: ctx.resourceId },
          include: {
            project: { select: { name: true, code: true, customer: { select: { companyName: true, contactPerson: true } } } },
            inspector: { select: { user: { select: { name: true } } } },
          },
        });
        if (!r) break;
        out.REPORT_NUMBER = r.code;
        out.PROJECT_NAME = r.project?.name ?? "";
        out.REPORT_STATUS = r.status;
        out.INSPECTOR_NAME = r.inspector?.user?.name ?? "";
        out.CUSTOMER_NAME = r.project?.customer?.companyName || r.project?.customer?.contactPerson || "";
        break;
      }
      // ── HR letters ──
      case "HR_LETTER_SENT":
      case "HR_LETTER_APPROVED": {
        const l = await db.letter.findUnique({ where: { id: ctx.resourceId }, select: { letterNumber: true, subject: true, letterDate: true } });
        if (!l) break;
        out.LETTER_NUMBER = l.letterNumber;
        out.LETTER_SUBJECT = l.subject;
        out.LETTER_DATE = dateStr(l.letterDate);
        break;
      }
      // ── System alerts ──
      case "SYSTEM_ALERT": {
        out.ALERT_TITLE = String(ctx.payload.title ?? "System alert");
        out.ALERT_MESSAGE = String(ctx.payload.message ?? "");
        if (!out.ALERT_MESSAGE) {
          // Enrich from the resource when the payload carries no message (LOW_STOCK etc.).
          const extra = await alertDetail(ctx.eventType, ctx.resourceType, ctx.resourceId);
          if (extra) out.ALERT_MESSAGE = extra;
        }
        break;
      }
      // ── Generic notifications (EMAIL_SEND events) ──
      case "GENERAL_NOTIFICATION": {
        out.NOTIFICATION_TITLE = String(ctx.payload.title ?? "Notification");
        out.NOTIFICATION_MESSAGE = String(ctx.payload.message ?? "");
        break;
      }
    }
  } catch (e) {
    // Resolution failures degrade to fewer variables — never throw (§2).
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "email-resolve-failed", templateKey, resourceId: ctx.resourceId, err: e instanceof Error ? e.message : String(e) }));
  }
  return out;
}

async function alertDetail(eventType: string, resourceType: string, resourceId: string): Promise<string> {
  if (eventType === "LOW_STOCK" && resourceType === "INVENTORY_ITEM") {
    const item = await db.inventoryItem.findUnique({ where: { id: resourceId }, select: { name: true, sku: true, stockQty: true, minStockQty: true } });
    if (item) return `${item.name} (${item.sku}) is at ${item.stockQty} units — minimum is ${item.minStockQty}. Please restock.`;
  }
  if (eventType === "SLA_BREACH_COMPLAINT" && resourceType === "COMPLAINT") {
    const c = await db.complaint.findUnique({ where: { id: resourceId }, select: { code: true, title: true, priority: true } });
    if (c) return `Complaint ${c.code} (${c.title}) breached its ${c.priority} response target.`;
  }
  if (eventType === "WO_OVERDUE" && resourceType === "WORK_ORDER") {
    const w = await db.workOrder.findUnique({ where: { id: resourceId }, select: { code: true, title: true } });
    if (w) return `Work order ${w.code} (${w.title}) has been in progress longer than the escalation threshold.`;
  }
  return String(resourceType || "System");
}
