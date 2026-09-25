// MOHD.HMS ENTERPRISE — Sample data contexts for template previews (§33/§34).
//
// The template preview must render through the SAME block renderers and the
// SAME central PDF engine as production documents — the only difference is the
// DATA. These are realistic, obviously-sample datasets (INV-2026-000123 / ABC
// Company / BND 5,250.00 …). No production record is ever touched, and no
// private customer data is used (§47 — safe sample data by default).

import "server-only";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import type { DocHeaderInfo } from "./engine";
import type { Branding } from "./branding";
import type { TemplateType } from "./template-meta";

export type SampleCtx = {
  header: DocHeaderInfo;
  data: Record<string, unknown>;
  qr: { png: Buffer | Uint8Array; reference: string } | null;
  vars: Record<string, string>;
};

// ── shared sample assets ────────────────────────────────────────────────────

let sampleQrPng: Buffer | null | undefined;

/** Honest sample QR: production documents embed the centralized verification
 *  identity from the QR service; a preview must NOT mint a fake token, so the
 *  sample code encodes an explanatory string instead. */
export function sampleQr(): Buffer | null {
  if (sampleQrPng !== undefined) return sampleQrPng;
  try {
    sampleQrPng = Buffer.from(
      QRCode.toBuffer(
        "MOHD.HMS ENTERPRISE — template preview. Production documents embed the centralized https://app.mohdhms.com/verify/{token} link.",
        { errorCorrectionLevel: "H", margin: 1, width: 240 }
      )
    );
  } catch {
    sampleQrPng = null;
  }
  return sampleQrPng;
}

/** A neutral demo image for photo-grid previews (the canonical brand logo —
 *  aspect-ratio preserving rendering is what the grid demonstrates). */
function samplePhotoBytes(): Buffer | null {
  try {
    return fs.readFileSync(path.join(process.cwd(), "public", "brand", "logo-256.png"));
  } catch {
    return null;
  }
}

const H = (over: Partial<DocHeaderInfo>): DocHeaderInfo => ({
  company: "",
  contactLines: [],
  docTitle: "",
  docNumber: "",
  docDateLabel: "",
  ...over,
});

const photoCells = (n: number, captions: string[]) => {
  const bytes = samplePhotoBytes();
  return Array.from({ length: n }, (_, i) => ({
    caption: captions[i % captions.length],
    number: `P-${String(i + 1).padStart(3, "0")}`,
    bytes,
  }));
};

const company_name = "MOHD.HMS Enterprise";

// ── sample contexts per document type ───────────────────────────────────────

export async function sampleContext(type: TemplateType, brand: Branding): Promise<SampleCtx> {
  const company = brand.company || company_name;
  const varsCompany = { company_name: company };

  switch (type) {
    case "invoice": {
      const inv = {
        code: "INV-2026-000123",
        status: "PARTIALLY_PAID",
        invoiceDate: new Date("2026-02-12"),
        dueDate: new Date("2026-03-14"),
        subtotalCents: 525000,
        discountCents: 0,
        shippingCents: 2500,
        taxCents: 31500,
        totalCents: 559000,
        paidCents: 300000,
        balanceCents: 259000,
        notes: "Thank you for your business. Please quote the invoice number with your payment.",
        terms: "Payment due within 30 days. Late payments may incur a 1.5% monthly surcharge.",
        customer: {
          code: "CUS-0014",
          companyName: "ABC Company",
          contactPerson: "Sarah Lim",
          email: "accounts@abccompany.example",
          phone: "+673 234-5678",
          address: "Unit 7, Jalan Muara Commercial Centre",
          city: "Bandar Seri Begawan",
        },
        quotation: { code: "QUO-2026-00088" },
        workOrders: [{ code: "WO-2026-0041" }, { code: "WO-2026-0052" }],
        items: [
          { description: "Quarterly preventive maintenance — AHU-01", kind: "SERVICE", quantity: 1, unit: "visit", unitPriceCents: 180000 },
          { description: "Replace air filter set (12 pcs)", kind: "MATERIAL", quantity: 12, unit: "pcs", unitPriceCents: 12500 },
          { description: "Emergency call-out — chiller fault", kind: "SERVICE", quantity: 2, unit: "hour", unitPriceCents: 95000 },
        ],
        payments: [
          { code: "PAY-2026-0031", paidAt: new Date("2026-02-20"), method: "BANK_TRANSFER", reference: "TT-88213", amountCents: 300000 },
        ],
      };
      return {
        header: H({
          company,
          contactLines: brand.contactLines,
          addressLines: brand.addressLines,
          contactLine: brand.contactLine,
          docTitle: "Invoice",
          docNumber: inv.code,
          docDateLabel: `Issued 12 Feb 2026`,
          meta: [["Status", "Partially Paid"], ["Due", "14 Mar 2026"]],
        }),
        data: inv,
        qr: sampleQr() ? { png: sampleQr()!, reference: inv.code } : null,
        vars: {
          invoice_number: inv.code,
          invoice_date: "12 Feb 2026",
          due_date: "14 Mar 2026",
          status: "Partially Paid",
          customer_name: "ABC Company",
          customer_address: "Unit 7, Jalan Muara Commercial Centre, Bandar Seri Begawan",
          customer_contact: "Sarah Lim · +673 234-5678",
          quotation_ref: "QUO-2026-00088",
          work_order_refs: "WO-2026-0041, WO-2026-0052",
          item_count: "3",
          subtotal: "BND 5,250.00",
          discount: "BND 0.00",
          shipping: "BND 25.00",
          tax: "BND 315.00",
          total: "BND 5,590.00",
          amount_paid: "BND 3,000.00",
          balance: "BND 2,590.00",
          ...varsCompany,
        },
      };
    }

    case "quotation": {
      const q = {
        code: "QUO-2026-00088",
        status: "SENT",
        quotationDate: new Date("2026-02-02"),
        validUntil: new Date("2026-03-02"),
        subtotalCents: 480000,
        discountCents: 0,
        shippingCents: 2500,
        taxCents: 28800,
        totalCents: 511300,
        notes: "Prices are based on site conditions observed at the time of quotation.",
        terms: "Quotation valid for 30 days. 50% deposit required on award.",
        customer: {
          code: "CUS-0014",
          companyName: "ABC Company",
          contactPerson: "Sarah Lim",
          email: "accounts@abccompany.example",
          phone: "+673 234-5678",
          address: "Unit 7, Jalan Muara Commercial Centre",
          city: "Bandar Seri Begawan",
        },
        items: [
          { description: "Annual service contract — HVAC systems", kind: "SERVICE", quantity: 12, unit: "month", unitPriceCents: 35000 },
          { description: "Water feature pump overhaul", kind: "SERVICE", quantity: 1, unit: "lot", unitPriceCents: 60000 },
          { description: "Spare parts bundle", kind: "MATERIAL", quantity: 1, unit: "lot", unitPriceCents: 25000 },
        ],
      };
      return {
        header: H({
          company,
          contactLines: brand.contactLines,
          addressLines: brand.addressLines,
          contactLine: brand.contactLine,
          docTitle: "Quotation",
          docNumber: q.code,
          docDateLabel: `Dated 2 Feb 2026`,
          meta: [["Status", "Sent"], ["Valid Until", "2 Mar 2026"]],
        }),
        data: q,
        qr: sampleQr() ? { png: sampleQr()!, reference: q.code } : null,
        vars: {
          quotation_number: q.code,
          quotation_date: "2 Feb 2026",
          valid_until: "2 Mar 2026",
          status: "Sent",
          customer_name: "ABC Company",
          customer_address: "Unit 7, Jalan Muara Commercial Centre, Bandar Seri Begawan",
          customer_contact: "Sarah Lim · accounts@abccompany.example",
          item_count: "3",
          subtotal: "BND 4,800.00",
          discount: "BND 0.00",
          shipping: "BND 25.00",
          tax: "BND 288.00",
          total: "BND 5,113.00",
          ...varsCompany,
        },
      };
    }

    case "inspection-report": {
      const r = {
        code: "INS-2026-0002",
        status: "APPROVED",
        overallCondition: "FAIR",
        revision: 1,
        clientComment: "",
        jobOrderNo: "JO-2026-0091",
        type: "PREVENTIVE",
        inspectionDate: new Date("2026-02-05"),
        building: "Block A",
        floor: "Level 3",
        room: "Plant Room",
        taskDescription: "Quarterly inspection of the central chilled water plant and associated distribution.",
        summary: "Plant generally serviceable. Two items require scheduled attention; no safety-critical defects found.",
        scope: "Visual + operational inspection of chillers, pumps and AHUs",
        correctiveActions: "Clean strainer on CHWP-2; tighten terminal connections on AHU-3.",
        rootCause: "",
        safetyNotes: "LOTO applied during panel inspection.",
        materials: "2x filter sets consumed",
        notes: "",
        labourHours: 6,
        completionPercent: 100,
        project: { code: "PRJ-2026-003", name: "Sunrise Mall Maintenance", siteLocation: "Sunrise Mall, Jalan Tutong", customer: { companyName: "Sunrise Mall Sdn Bhd", contactPerson: "Hafiz Rahman" } },
        equipment: { name: "Chiller CH-01", assetTag: "EQ-0121" },
        workOrder: { code: "WO-2026-0039", title: "Quarterly plant inspection" },
        inspector: { employeeNo: "EMP-0021", user: { name: "Azmi Yusof" } },
        findings: [
          { finding: "CHWP-2 suction strainer partially clogged", severity: "MEDIUM", recommendation: "Clean strainer and re-test differential pressure." },
          { finding: "AHU-3 belt wear beyond 30%", severity: "LOW", recommendation: "Replace belt set at next PM visit." },
        ],
        photos: [
          { photoNo: "P-001", category: "BEFORE", caption: "Plant room overview", room: "Plant Room", building: "Block A", storagePath: "", displayPath: "" },
          { photoNo: "P-002", category: "BEFORE", caption: "CHWP-2 strainer", room: "Plant Room", building: "Block A", storagePath: "", displayPath: "" },
          { photoNo: "P-003", category: "BEFORE", caption: "AHU-3 belt drive", room: "Level 3", building: "Block A", storagePath: "", displayPath: "" },
          { photoNo: "P-004", category: "DURING", caption: "Strainer cleaning", room: "Plant Room", building: "Block A", storagePath: "", displayPath: "" },
          { photoNo: "P-005", category: "AFTER", caption: "Clean strainer installed", room: "Plant Room", building: "Block A", storagePath: "", displayPath: "" },
          { photoNo: "P-006", category: "AFTER", caption: "New belt set", room: "Level 3", building: "Block A", storagePath: "", displayPath: "" },
        ],
        signatures: [],
        approvals: [
          { step: "REVIEW", fromStatus: "DRAFT", toStatus: "IN_REVIEW", userName: "Azmi Yusof", comment: "Submitted for review", createdAt: new Date("2026-02-06T09:12:00") },
          { step: "APPROVE", fromStatus: "IN_REVIEW", toStatus: "APPROVED", userName: "Noraini Hassan", comment: "Approved", createdAt: new Date("2026-02-07T14:30:00") },
        ],
      };
      return {
        header: H({
          company,
          contactLines: brand.contactLines,
          addressLines: brand.addressLines,
          contactLine: brand.contactLine,
          docTitle: "Inspection Report",
          docNumber: r.code,
          docDateLabel: `Inspected 5 Feb 2026`,
          meta: [["Status", "Approved"], ["Overall", "Fair"], ["Revision", "Rev 1"]],
        }),
        data: r,
        qr: sampleQr() ? { png: sampleQr()!, reference: r.code } : null,
        vars: {
          inspection_number: r.code,
          project_number: "PRJ-2026-003",
          project_name: "Sunrise Mall Maintenance",
          client: "Sunrise Mall Sdn Bhd",
          equipment: "Chiller CH-01 (EQ-0121)",
          inspector: "Azmi Yusof (EMP-0021)",
          inspection_date: "5 Feb 2026",
          status: "Approved",
          overall_condition: "Fair",
          revision: "Rev 1",
          finding_count: "2",
          ...varsCompany,
        },
      };
    }

    case "work-order": {
      const wo = {
        code: "WO-2026-0041",
        title: "AHU-01 quarterly service",
        description: "Quarterly preventive service of AHU-01 including filter replacement and coil cleaning.",
        status: "COMPLETED",
        priority: "NORMAL",
        notes: "Access arranged with building management.",
        customerConfirmed: true,
        confirmedAt: new Date("2026-02-10T16:45:00"),
        scheduledDate: new Date("2026-02-09"),
        startedAt: new Date("2026-02-09T08:30:00"),
        completedAt: new Date("2026-02-09T13:10:00"),
        labourTotalCents: 190000,
        labourHours: 4,
        labourRateCents: 47500,
        materialsTotalCents: 150000,
        totalCents: 340000,
        complaint: { code: "CPT-2026-0021", title: "Weak airflow level 2" },
        customer: { code: "CUS-0014", companyName: "ABC Company", contactPerson: "Sarah Lim", phone: "+673 234-5678", address: "Unit 7, Jalan Muara Commercial Centre", city: "Bandar Seri Begawan" },
        equipment: { name: "AHU-01", assetTag: "EQ-0087", serialNumber: "AHU-88231" },
        technician: { employeeNo: "EMP-0032", user: { name: "Rashid Bin Omar" } },
        checklist: [
          { required: true, label: "Replace supply air filters", unit: "", responseType: "CHECKBOX", done: true, response: "", notes: "", origin: "PM_TEMPLATE" },
          { required: true, label: "Clean cooling coil", unit: "", responseType: "CHECKBOX", done: true, response: "", notes: "Foam coil cleaner applied", origin: "PM_TEMPLATE" },
          { required: true, label: "Measure supply airflow", unit: "l/s", responseType: "NUMERIC", done: true, response: "1450", notes: "", origin: "MANUAL" },
        ],
        materials: [{ name: "Air filter set 500x500x46", quantity: 4, unit: "pcs", unitCostCents: 12500, totalCents: 50000 }],
      };
      return {
        header: H({
          company,
          contactLines: brand.contactLines,
          addressLines: brand.addressLines,
          contactLine: brand.contactLine,
          docTitle: "Work Order",
          docNumber: wo.code,
          docDateLabel: `Created 8 Feb 2026`,
          meta: [["Status", "Completed"], ["Priority", "Normal"]],
        }),
        data: wo,
        qr: sampleQr() ? { png: sampleQr()!, reference: wo.code } : null,
        vars: {
          work_order_number: wo.code,
          status: "Completed",
          priority: "Normal",
          customer_name: "ABC Company",
          equipment: "AHU-01 (EQ-0087)",
          technician: "Rashid Bin Omar (EMP-0032)",
          scheduled_date: "9 Feb 2026",
          total: "BND 3,400.00",
          ...varsCompany,
        },
      };
    }

    case "pm-task": {
      const t = {
        code: "PM-2026-0077",
        status: "COMPLETED",
        dueDate: new Date("2026-02-15"),
        completedAt: new Date("2026-02-14T11:20:00"),
        notes: "All items satisfactory. Next visit scheduled within cycle.",
        plan: { code: "PM-PLAN-004", name: "Monthly AHU service", frequency: "MONTHLY" },
        equipment: { name: "AHU-01", assetTag: "EQ-0087", location: { name: "Block A Roof" } },
        technician: { employeeNo: "EMP-0032", user: { name: "Rashid Bin Omar" } },
        checklist: [
          { label: "Inspect belts and pulleys", done: true },
          { label: "Check condensate drain", done: true },
          { label: "Record motor current", done: true },
          { label: "Replace filters", done: true },
        ],
      };
      return {
        header: H({
          company,
          contactLines: brand.contactLines,
          addressLines: brand.addressLines,
          contactLine: brand.contactLine,
          docTitle: "PM Service Sheet",
          docNumber: t.code,
          docDateLabel: `Due 15 Feb 2026`,
          meta: [["Status", "Completed"]],
        }),
        data: t,
        qr: sampleQr() ? { png: sampleQr()!, reference: t.code } : null,
        vars: {
          task_number: t.code,
          status: "Completed",
          plan_name: "Monthly AHU service",
          equipment: "AHU-01 (EQ-0087)",
          technician: "Rashid Bin Omar (EMP-0032)",
          due_date: "15 Feb 2026",
          ...varsCompany,
        },
      };
    }

    case "equipment-report": {
      const e = {
        assetTag: "EQ-0087",
        name: "AHU-01",
        category: "HVAC",
        status: "ACTIVE",
        manufacturer: "AirTech",
        model: "AT-500",
        serialNumber: "AHU-88231",
        installationDate: new Date("2023-06-01"),
        warrantyExpiry: new Date("2026-06-01"),
        pmFrequencyDays: 30,
        notes: "Primary air handling unit serving levels 1-3.",
        location: { name: "Block A Roof", code: "LOC-A-RF" },
        customer: { code: "CUS-0014", companyName: "ABC Company", contactPerson: "Sarah Lim" },
        pmPlans: [{ code: "PM-PLAN-004", name: "Monthly AHU service", frequency: "MONTHLY", nextDueDate: new Date("2026-03-15"), active: true }],
        workOrders: [{ code: "WO-2026-0041", title: "AHU-01 quarterly service", status: "COMPLETED", createdAt: new Date("2026-02-08") }],
        complaints: [{ code: "CPT-2026-0021", title: "Weak airflow level 2", status: "RESOLVED", createdAt: new Date("2026-01-28") }],
      };
      return {
        header: H({
          company,
          contactLines: brand.contactLines,
          addressLines: brand.addressLines,
          contactLine: brand.contactLine,
          docTitle: "Equipment Report",
          docNumber: e.assetTag,
          docDateLabel: `Generated 20 Feb 2026`,
          meta: [["Status", "Active"]],
        }),
        data: e,
        qr: sampleQr() ? { png: sampleQr()!, reference: e.assetTag } : null,
        vars: {
          asset_tag: e.assetTag,
          name: e.name,
          category: "HVAC",
          status: "Active",
          manufacturer: "AirTech",
          model: "AT-500",
          serial_number: "AHU-88231",
          location: "Block A Roof (LOC-A-RF)",
          customer_name: "ABC Company",
          ...varsCompany,
        },
      };
    }

    case "complaint": {
      const c = {
        code: "CPT-2026-0021",
        status: "RESOLVED",
        priority: "HIGH",
        description: "Tenants report weak airflow on level 2 since Monday morning.",
        resolutionNotes: "Dirty filters replaced and fan speed reset to design setpoint. Airflow restored.",
        customerFeedback: "Fixed quickly, thank you.",
        customerRating: 5,
        createdAt: new Date("2026-01-28T08:40:00"),
        assignedAt: new Date("2026-01-28T09:05:00"),
        startedAt: new Date("2026-01-28T10:00:00"),
        completedAt: new Date("2026-01-28T15:30:00"),
        closedAt: new Date("2026-01-29T09:00:00"),
        customer: { code: "CUS-0014", companyName: "ABC Company", contactPerson: "Sarah Lim", phone: "+673 234-5678" },
        equipment: { name: "AHU-01", assetTag: "EQ-0087" },
        assignedTechnician: { employeeNo: "EMP-0032", user: { name: "Rashid Bin Omar" } },
        statusHistory: [
          { createdAt: new Date("2026-01-28T08:40:00"), fromStatus: "", toStatus: "OPEN", changedById: "", note: "Logged by tenant services" },
          { createdAt: new Date("2026-01-28T09:05:00"), fromStatus: "OPEN", toStatus: "ASSIGNED", changedById: "", note: "" },
          { createdAt: new Date("2026-01-28T15:30:00"), fromStatus: "IN_PROGRESS", toStatus: "RESOLVED", changedById: "", note: "Filters replaced" },
        ],
        workOrders: [{ code: "WO-2026-0041", title: "AHU-01 quarterly service", status: "COMPLETED" }],
      };
      return {
        header: H({
          company,
          contactLines: brand.contactLines,
          addressLines: brand.addressLines,
          contactLine: brand.contactLine,
          docTitle: "Complaint Report",
          docNumber: c.code,
          docDateLabel: `Received 28 Jan 2026, 8:40 AM`,
          meta: [["Status", "Resolved"], ["Priority", "High"]],
        }),
        data: c,
        qr: sampleQr() ? { png: sampleQr()!, reference: c.code } : null,
        vars: {
          complaint_number: c.code,
          status: "Resolved",
          priority: "High",
          customer_name: "ABC Company",
          equipment: "AHU-01 (EQ-0087)",
          technician: "Rashid Bin Omar (EMP-0032)",
          ...varsCompany,
        },
      };
    }

    case "purchase-order": {
      const po = {
        code: "PO-2026-0019",
        status: "APPROVED",
        orderDate: new Date("2026-02-03"),
        expectedDate: new Date("2026-02-17"),
        approvedAt: new Date("2026-02-04T10:15:00"),
        notes: "Deliver to Block A store.",
        subtotalCents: 385000,
        taxCents: 23100,
        totalCents: 408100,
        supplier: { code: "SUP-006", name: "Brunei Mechanical Supplies", contactPerson: "James Chin", email: "sales@bms.example", phone: "+673 222-3344", address: "No. 12, Jalan Gadong" },
        items: [
          { description: "Air filter set 500x500x46", item: { sku: "FLT-500" }, quantity: 20, receivedQty: 20, unitCostCents: 11500, totalCents: 230000 },
          { description: "V-belt A55", item: { sku: "BLT-A55" }, quantity: 10, receivedQty: 10, unitCostCents: 15500, totalCents: 155000 },
        ],
      };
      return {
        header: H({
          company,
          contactLines: brand.contactLines,
          addressLines: brand.addressLines,
          contactLine: brand.contactLine,
          docTitle: "Purchase Order",
          docNumber: po.code,
          docDateLabel: `Ordered 3 Feb 2026`,
          meta: [["Status", "Approved"]],
        }),
        data: po,
        qr: sampleQr() ? { png: sampleQr()!, reference: po.code } : null,
        vars: {
          po_number: po.code,
          order_date: "3 Feb 2026",
          expected_delivery: "17 Feb 2026",
          status: "Approved",
          supplier_name: "Brunei Mechanical Supplies",
          total: "BND 4,081.00",
          ...varsCompany,
        },
      };
    }

    case "payment-receipt": {
      const p = {
        code: "PAY-2026-0031",
        status: "CONFIRMED",
        paidAt: new Date("2026-02-20"),
        method: "BANK_TRANSFER",
        reference: "TT-88213",
        note: "",
        amountCents: 300000,
        customer: { companyName: "ABC Company", contactPerson: "Sarah Lim" },
        invoice: {
          code: "INV-2026-000123",
          customerId: "cus_demo",
          invoiceDate: new Date("2026-02-12"),
          totalCents: 559000,
          paidCents: 300000,
          balanceCents: 259000,
          status: "PARTIALLY_PAID",
          customer: { companyName: "ABC Company", contactPerson: "Sarah Lim" },
        },
      };
      return {
        header: H({
          company,
          contactLines: brand.contactLines,
          addressLines: brand.addressLines,
          contactLine: brand.contactLine,
          docTitle: "Payment Receipt",
          docNumber: p.code,
          docDateLabel: `Received 20 Feb 2026`,
          meta: [["Method", "Bank Transfer"]],
        }),
        data: p,
        qr: sampleQr() ? { png: sampleQr()!, reference: p.code } : null,
        vars: {
          receipt_number: p.code,
          receipt_date: "20 Feb 2026",
          method: "Bank Transfer",
          reference: "TT-88213",
          received_from: "ABC Company",
          invoice_number: "INV-2026-000123",
          amount: "BND 3,000.00",
          ...varsCompany,
        },
      };
    }
  }
}
