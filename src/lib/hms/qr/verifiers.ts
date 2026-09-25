// MOHD.HMS ENTERPRISE — Public verification DTO registry (ch.35 spec §6/§20/
// §32/§63). For every QR entity type this registry loads the AUTHORITATIVE
// record from PostgreSQL and projects ONLY the explicitly approved public
// fields. The internal entity is NEVER serialized to the public verifier —
// a deliberate whitelist DTO per type (§63: PublicXxxVerificationDTO).
//
// Restricted records (drafts, unapproved reports — §61) resolve to
// `{ restricted: true }`: the page shows a neutral "not available for public
// verification" notice WITHOUT leaking status details or even confirming
// fields of the underlying record.

import "server-only";
import { db } from "@/lib/db";
import { fmtDate, money } from "@/lib/hms/format";
import { humanize } from "@/lib/hms/constants";
import type { Permission } from "@/lib/hms/constants";

export type PublicVerification = {
  /** humanized entity label, e.g. "Invoice", "Equipment" */
  label?: string;
  /** primary document/asset number, e.g. INV-2026-000123 */
  number: string;
  numberLabel: string;
  /** authoritative business status shown on the page (§32) */
  recordStatus: string;
  statusLabel: string;
  fields: Array<[string, string]>;
  /** true → record exists but is NOT publicly verifiable (drafts §61) */
  restricted?: boolean;
  /** explicit override when the business state maps to a verification state */
  verifyState?: "CANCELLED" | "SUPERSEDED";
  /** what the scanner can do after a positive verification (§35) */
  access: { requiresLogin: boolean; note: string } | null;
  /** optional INTERNAL in-app route offered AFTER verification (QR spec §12
   *  "internal routing after verification"). Only ever an app deep link —
   *  reaching the record still requires signing in + full server-side RBAC. */
  openPath?: string;
};

type EntityVerifier = {
  permission: Permission;
  load: (id: string) => Promise<PublicVerification | null>;
};

/** §35 — documents stay protected: verification proves authenticity; the
 *  document itself still requires signing in to MOHD.HMS. */
const LOGIN_ACCESS = {
  requiresLogin: true,
  note: "Document authenticity confirmed. Sign in to MOHD.HMS to view the full document.",
};

/** Shared PM record loader — PREVENTIVE_MAINTENANCE is the canonical spelling
 *  of the PM_TASK record type (QR spec §12); both resolve the same model. */
const PM_TASK_LOADER: (id: string) => Promise<PublicVerification | null> = async (id) => {
  const t = await db.pmTask.findUnique({
    where: { id },
    include: { equipment: { select: { name: true, assetTag: true } } },
  });
  if (!t) return null;
  return {
    number: t.code,
    numberLabel: "PM Record Number",
    recordStatus: t.status,
    statusLabel: humanize(t.status),
    fields: [
      ["Equipment", `${t.equipment.name} (${t.equipment.assetTag})`],
      ["Scheduled For", fmtDate(t.dueDate)],
      ["Completed", fmtDate(t.completedAt)],
      ["Status", humanize(t.status)],
    ],
    verifyState: t.status === "CANCELLED" ? "CANCELLED" : undefined,
    access: LOGIN_ACCESS,
  };
};

export const QR_VERIFIERS: Record<string, EntityVerifier> = {
  // ── EQUIPMENT (§14 — public asset identity; NO customer-confidential,
  //    cost, technician, notes or internal-id exposure) ────────────────────
  EQUIPMENT: {
    permission: "equipment.read" as Permission,
    async load(id) {
      const eq = await db.equipment.findUnique({
        where: { id },
        include: { location: { select: { name: true } } },
      });
      if (!eq) return null;
      return {
        number: eq.assetTag,
        numberLabel: "Equipment ID",
        recordStatus: eq.status,
        statusLabel: humanize(eq.status),
        fields: [
          ["Equipment Name", eq.name],
          ["Category", humanize(eq.category)],
          ["Manufacturer / Model", [eq.manufacturer, eq.model].filter(Boolean).join(" · ") || "—"],
          ["Serial Number", eq.serialNumber || "—"],
          ["Location", eq.location?.name || "—"],
          ["Installed", fmtDate(eq.installationDate)],
        ],
        access: null,
        // §12/§21 — signed-in staff can jump from the verification page into
        // the asset record via the EXISTING deep-link mechanism. The token is
        // a locator (already printed on the physical label), not a credential:
        // the destination still enforces equipment.read + customer scoping.
        openPath: `/?resource=equipment:${eq.qrToken}`,
      };
    },
  },

  // ── INVOICE (§16 — same safe fields the printed invoice already carries;
  //    amounts shown as formatted BND strings, never raw cents) ─────────────
  INVOICE: {
    permission: "invoices.read" as Permission,
    async load(id) {
      const inv = await db.invoice.findUnique({
        where: { id },
        include: { customer: { select: { companyName: true } } },
      });
      if (!inv) return null;
      if (inv.status === "DRAFT") return restricted(); // §61 — drafts never public
      return {
        number: inv.code,
        numberLabel: "Invoice Number",
        recordStatus: inv.status,
        statusLabel: humanize(inv.status),
        fields: [
          ["Customer", inv.customer.companyName],
          ["Issue Date", fmtDate(inv.invoiceDate)],
          ["Due Date", fmtDate(inv.dueDate)],
          ["Total", money(inv.totalCents)],
          ["Amount Paid", money(inv.paidCents)],
          ["Payment Status", humanize(inv.status)],
        ],
        verifyState: inv.status === "CANCELLED" ? "CANCELLED" : undefined,
        access: LOGIN_ACCESS,
      };
    },
  },

  // ── QUOTATION (§17 — no internal cost fields: labourCost/materialCost are
  //    internal margins and are NEVER exposed) ──────────────────────────────
  QUOTATION: {
    permission: "quotations.read" as Permission,
    async load(id) {
      const q = await db.quotation.findUnique({
        where: { id },
        include: { customer: { select: { companyName: true } } },
      });
      if (!q) return null;
      if (q.status === "DRAFT") return restricted();
      return {
        number: q.code,
        numberLabel: "Quotation Number",
        recordStatus: q.status,
        statusLabel: humanize(q.status),
        fields: [
          ["Client", q.customer.companyName],
          ["Quotation Date", fmtDate(q.quotationDate)],
          ["Valid Until", fmtDate(q.validUntil)],
          ["Total", money(q.totalCents)],
          ["Status", humanize(q.status)],
        ],
        verifyState: q.status === "REJECTED" ? "CANCELLED" : q.status === "CONVERTED" ? "SUPERSEDED" : undefined,
        access: LOGIN_ACCESS,
      };
    },
  },

  // ── WORK ORDER (§18 — identity/status only; no costs, no technician
  //    personal details) ────────────────────────────────────────────────────
  WORK_ORDER: {
    permission: "work_orders.read" as Permission,
    async load(id) {
      const wo = await db.workOrder.findUnique({
        where: { id },
        include: {
          equipment: { select: { name: true, assetTag: true } },
        },
      });
      if (!wo) return null;
      return {
        number: wo.code,
        numberLabel: "Work Order Number",
        recordStatus: wo.status,
        statusLabel: humanize(wo.status),
        fields: [
          ["Title", wo.title || "—"],
          ["Created", fmtDate(wo.createdAt)],
          ["Service Date", fmtDate(wo.scheduledDate)],
          ["Completed", fmtDate(wo.completedAt)],
          ["Equipment", wo.equipment ? `${wo.equipment.name} (${wo.equipment.assetTag})` : "—"],
          ["Work Category", humanize(wo.sourceType)],
          ["Status", humanize(wo.status)],
        ],
        verifyState: wo.status === "CANCELLED" ? "CANCELLED" : undefined,
        access: LOGIN_ACCESS,
      };
    },
  },

  // ── COMPLAINT (§19 — minimal safe identity; customer and descriptions
  //    stay private) ─────────────────────────────────────────────────────────
  COMPLAINT: {
    permission: "complaints.read" as Permission,
    async load(id) {
      const c = await db.complaint.findUnique({
        where: { id },
        include: { equipment: { select: { name: true, assetTag: true } } },
      });
      if (!c) return null;
      return {
        number: c.code,
        numberLabel: "Complaint Reference",
        recordStatus: c.status,
        statusLabel: humanize(c.status),
        fields: [
          ["Subject", c.title || "—"],
          ["Created Date", fmtDate(c.createdAt)],
          ["Related Equipment", c.equipment ? `${c.equipment.name} (${c.equipment.assetTag})` : "—"],
          ["Status", humanize(c.status)],
        ],
        access: LOGIN_ACCESS,
      };
    },
  },

  // ── INSPECTION REPORT (§20 — only final APPROVED/ARCHIVED reports are
  //    publicly verifiable; every other state is RESTRICTED §61) ────────────
  INSPECTION_REPORT: {
    permission: "irms.read" as Permission,
    async load(id) {
      const r = await db.inspectionReport.findUnique({
        where: { id },
        include: { project: { select: { name: true } } },
      });
      if (!r) return null;
      if (r.status !== "APPROVED" && r.status !== "ARCHIVED") return restricted();
      return {
        number: r.code,
        numberLabel: "Inspection Report Number",
        recordStatus: r.status,
        statusLabel: humanize(r.status),
        fields: [
          ["Project", r.project.name],
          ["Report Title", r.title || "—"],
          ["Inspection Date", fmtDate(r.inspectionDate)],
          ["Overall Condition", humanize(r.overallCondition)],
          ["Report Status", humanize(r.status)],
        ],
        access: LOGIN_ACCESS,
      };
    },
  },

  // ── PAYMENT RECEIPT (payment proof of settlement) ────────────────────────
  PAYMENT_RECEIPT: {
    permission: "payments.read" as Permission,
    async load(id) {
      const p = await db.payment.findUnique({
        where: { id },
        include: {
          invoice: { select: { code: true } },
          customer: { select: { companyName: true } },
        },
      });
      if (!p) return null;
      if (p.status === "ON_HOLD" || p.status === "REJECTED") return restricted();
      return {
        number: p.code,
        numberLabel: "Receipt Number",
        recordStatus: p.status,
        statusLabel: humanize(p.status),
        fields: [
          ["Amount", money(p.amountCents)],
          ["Paid On", fmtDate(p.paidAt)],
          ["Method", humanize(p.method)],
          ["Applied Invoice", p.invoice?.code || "—"],
        ],
        verifyState: p.status === "REJECTED" ? "CANCELLED" : undefined,
        access: LOGIN_ACCESS,
      };
    },
  },

  // ── PURCHASE ORDER (§50 — supplier-facing authenticity; totals are what
  //    the supplier already holds on the printed PO) ─────────────────────────
  PURCHASE_ORDER: {
    permission: "purchases.read" as Permission,
    async load(id) {
      const po = await db.purchaseOrder.findUnique({
        where: { id },
        include: { supplier: { select: { name: true } } },
      });
      if (!po) return null;
      if (po.status === "DRAFT") return restricted();
      return {
        number: po.code,
        numberLabel: "Purchase Order Number",
        recordStatus: po.status,
        statusLabel: humanize(po.status),
        fields: [
          ["Supplier", po.supplier.name],
          ["Order Date", fmtDate(po.orderDate)],
          ["Expected Delivery", fmtDate(po.expectedDate)],
          ["Order Total", money(po.totalCents)],
          ["Status", humanize(po.status)],
        ],
        verifyState: po.status === "REJECTED" || po.status === "CANCELLED" ? "CANCELLED" : undefined,
        access: LOGIN_ACCESS,
      };
    },
  },

  // ── PM TASK RECORD (PM compliance traceability — safe fields only) ───────
  PM_TASK: {
    permission: "pm.read" as Permission,
    load: PM_TASK_LOADER,
  },

  // ── PREVENTIVE_MAINTENANCE (QR spec §12 — same PM record, canonical name) ─
  PREVENTIVE_MAINTENANCE: {
    permission: "pm.read" as Permission,
    load: PM_TASK_LOADER,
  },
};

function restricted(): PublicVerification {
  return {
    number: "",
    numberLabel: "",
    recordStatus: "",
    statusLabel: "",
    fields: [],
    restricted: true,
    access: null,
  };
}

/** Resolve a record through the registry. Returns null when the record no
 *  longer exists (deleted entity — §49 "deleted entity" test). */
export async function loadPublicVerification(entityType: string, entityId: string): Promise<PublicVerification | null> {
  const v = QR_VERIFIERS[entityType];
  if (!v) return null;
  try {
    return await v.load(entityId);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "qr.verifier_failed", entityType, err: String(err) }));
    return null;
  }
}

export function verifierLabel(entityType: string): string {
  return humanize(entityType.replace(/_/g, " "));
}
