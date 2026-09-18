// MOHD.HMS ENTERPRISE — Centralized document type registry (§6) + builders.
//
// ONE registry maps every existing business document to:
//   permission (§21 RBAC)  →  loader (§12 authoritative Prisma data,
//   customer-scoped)  →  render (central PdfDoc engine)  →  filename (§23).
//
// Routes never contain rendering code; they dispatch through this registry.
// All money passes through the central BND formatters in @/lib/hms/format.
// Only fields that actually exist in the database are included (§12).

import "server-only";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { isStaff } from "@/lib/hms/rbac";
import { PERMISSIONS, IRMS_PHOTO_CATEGORIES, IRMS_SIGNATURE_ROLES, humanize, type Permission } from "@/lib/hms/constants";
import { fmtDate, fmtDateTime, money } from "@/lib/hms/format";
import { PdfDoc, safeFilename, type DocHeaderInfo, type TableCol, type TableCell } from "./engine";
import { canonicalPhotoOrder, readVariantFile } from "@/lib/hms/irms/storage";
import type { Branding } from "./branding";
import QRCode from "qrcode";

export type PdfRequestUser = { id: string; role: string; customerId: string | null };

type Loaded = {
  header: DocHeaderInfo;
  filename: string;
  render: (d: PdfDoc) => void | Promise<void>;
};

export type DocumentDef = {
  type: string; // URL segment: /api/v1/pdf/{type}/{id}
  docTitle: string;
  permission: Permission;
  /** Additional permissions that ALSO grant access (e.g. irms.portal lets a
   *  customer download their own shared/approved inspection reports — the
   *  loader still enforces customer scoping, so this never widens visibility). */
  extraPermissions?: Permission[];
  filenameLabel: string; // §23 filename middle segment
  load: (id: string, user: PdfRequestUser, branding: Branding, origin?: string) => Promise<Loaded>;
};

export type BuiltDoc = {
  bytes: Uint8Array;
  pageCount: number;
  filename: string;
  docTitle: string;
  docNumber: string;
};

// ── helpers ────────────────────────────────────────────────────────────────

const qty = (q: number): string => (Number.isInteger(q) ? String(q) : q.toFixed(2));

/** Customers may only ever see their own records — invisible records 404. */
function assertVisible(customerId: string | null | undefined, user: PdfRequestUser, label: string): void {
  if (!isStaff(user.role) && customerId !== user.customerId) throw Errors.notFound(`${label} not found.`);
}

const moneyCols = (labels: [string, string, string, string]): TableCol[] => [
  { header: labels[0], width: 0.7 },
  { header: labels[1], width: 3.4 },
  { header: labels[2], width: 1.1, align: "center" },
  { header: labels[3], width: 1.5, align: "right" },
];

// ── 1. WORK ORDER ──────────────────────────────────────────────────────────

const workOrder: DocumentDef = {
  type: "work-order",
  docTitle: "Work Order",
  permission: PERMISSIONS.work_orders_read,
  filenameLabel: "Work-Order",
  async load(id, user, branding) {
    const wo = await db.workOrder.findUnique({
      where: { id },
      include: {
        complaint: { select: { code: true, title: true } },
        customer: { select: { code: true, companyName: true, contactPerson: true, phone: true, address: true, city: true } },
        equipment: { select: { name: true, assetTag: true, serialNumber: true } },
        technician: { select: { employeeNo: true, user: { select: { name: true } } } },
        checklist: { orderBy: { sortOrder: "asc" } },
        materials: { orderBy: { id: "asc" } },
      },
    });
    if (!wo) throw Errors.notFound("Work order not found.");
    assertVisible(wo.customerId, user, "Work order");

    return {
      header: {
        company: branding.company,
        contactLines: branding.contactLines,
        docTitle: "Work Order",
        docNumber: wo.code,
        docDateLabel: `Created ${fmtDate(wo.createdAt)}`,
        meta: [["Status", humanize(wo.status)], ["Priority", humanize(wo.priority)]],
      },
      filename: safeFilename(`MOHD-HMS-Work-Order-${wo.code}.pdf`),
      render: (d) => {
        d.kvGrid([
          ["Work Order", wo.code],
          ["Status", humanize(wo.status)],
          ["Priority", humanize(wo.priority)],
          ["Customer", wo.customer.companyName],
          ["Site / Address", [wo.customer.address, wo.customer.city].filter(Boolean).join(", ") || "—"],
          ["Contact", wo.customer.contactPerson ? `${wo.customer.contactPerson}${wo.customer.phone ? ` · ${wo.customer.phone}` : ""}` : wo.customer.phone || "—"],
          ["Equipment", wo.equipment ? `${wo.equipment.name} (${wo.equipment.assetTag})` : "—"],
          ["Source Complaint", wo.complaint ? `${wo.complaint.code} — ${wo.complaint.title}` : "—"],
          ["Assigned Technician", wo.technician ? `${wo.technician.user.name} (${wo.technician.employeeNo})` : "Unassigned"],
          ["Scheduled Date", fmtDate(wo.scheduledDate)],
          ["Started", fmtDateTime(wo.startedAt)],
          ["Completed", fmtDateTime(wo.completedAt)],
        ]);
        d.spacer(6);
        d.heading("Description");
        d.para(wo.description || wo.title || "—", { size: 9 });
        if (wo.checklist.length > 0) {
          d.heading("Checklist");
          d.table(
            [
              { header: "#", width: 0.4, align: "center" },
              { header: "Task", width: 4.4 },
              { header: "Status", width: 1.2, align: "center" },
            ],
            wo.checklist.map((c, i) => [
              { text: String(i + 1) },
              c.label,
              { text: c.done ? `Done${c.doneAt ? ` · ${fmtDate(c.doneAt)}` : ""}` : "Pending" },
            ])
          );
        }
        d.heading("Labour & Materials");
        d.table(
          [
            { header: "Item", width: 4.2 },
            { header: "Qty", width: 0.8, align: "center" },
            { header: "Unit Cost", width: 1.5, align: "right" },
            { header: "Total", width: 1.5, align: "right" },
          ],
          [
            ...(wo.labourTotalCents > 0 || wo.labourHours > 0
              ? [[
                  { text: "Labour", bold: true },
                  qty(wo.labourHours),
                  money(wo.labourRateCents),
                  money(wo.labourTotalCents),
                ] as TableCell[]]
              : []),
            ...wo.materials.map((m) => [
              m.name,
              qty(m.quantity) + (m.unit ? ` ${m.unit}` : ""),
              money(m.unitCostCents),
              money(m.totalCents),
            ]),
          ],
          { emptyHint: "No labour or materials recorded." }
        );
        d.totals([
          ["Labour total", money(wo.labourTotalCents)],
          ["Materials total", money(wo.materialsTotalCents)],
          ["Grand total", money(wo.totalCents)],
        ]);
        if (wo.notes?.trim()) d.notesBlock("Notes", wo.notes);
        d.banner(wo.customerConfirmed ? `Customer confirmed on ${fmtDate(wo.confirmedAt)}` : "Customer confirmation pending", wo.customerConfirmed ? "green" : "muted");
        d.signatures([{ caption: "Technician signature" }, { caption: "Customer signature" }]);
      },
    };
  },
};

// ── 2. COMPLAINT ───────────────────────────────────────────────────────────

const complaint: DocumentDef = {
  type: "complaint",
  docTitle: "Complaint Report",
  permission: PERMISSIONS.complaints_read,
  filenameLabel: "Complaint",
  async load(id, user, branding) {
    const c = await db.complaint.findUnique({
      where: { id },
      include: {
        customer: { select: { code: true, companyName: true, contactPerson: true, phone: true } },
        equipment: { select: { name: true, assetTag: true } },
        assignedTechnician: { select: { employeeNo: true, user: { select: { name: true } } } },
        statusHistory: { orderBy: { createdAt: "asc" } },
        workOrders: { select: { code: true, title: true, status: true } },
      },
    });
    if (!c) throw Errors.notFound("Complaint not found.");
    assertVisible(c.customerId, user, "Complaint");

    // Resolve timeline actor names in one query (changedById is a bare string).
    const actorIds = [...new Set(c.statusHistory.map((h) => h.changedById).filter((v): v is string => !!v))];
    const actors = actorIds.length > 0 ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
    const actorNames = new Map(actors.map((a) => [a.id, a.name]));

    return {
      header: {
        company: branding.company,
        contactLines: branding.contactLines,
        docTitle: "Complaint Report",
        docNumber: c.code,
        docDateLabel: `Received ${fmtDateTime(c.createdAt)}`,
        meta: [["Status", humanize(c.status)], ["Priority", humanize(c.priority)]],
      },
      filename: safeFilename(`MOHD-HMS-Complaint-${c.code}.pdf`),
      render: (d) => {
        d.kvGrid([
          ["Complaint", c.code],
          ["Status", humanize(c.status)],
          ["Priority", humanize(c.priority)],
          ["Customer", c.customer.companyName],
          ["Contact", c.customer.contactPerson ? `${c.customer.contactPerson}${c.customer.phone ? ` · ${c.customer.phone}` : ""}` : c.customer.phone || "—"],
          ["Equipment", c.equipment ? `${c.equipment.name} (${c.equipment.assetTag})` : "—"],
          ["Assigned Technician", c.assignedTechnician ? `${c.assignedTechnician.user.name} (${c.assignedTechnician.employeeNo})` : "Unassigned"],
          ["Received", fmtDateTime(c.createdAt)],
          ["Assigned", fmtDateTime(c.assignedAt)],
          ["Started", fmtDateTime(c.startedAt)],
          ["Completed", fmtDateTime(c.completedAt)],
          ["Closed", fmtDateTime(c.closedAt)],
        ]);
        d.spacer(6);
        d.heading("Description");
        d.para(c.description || "—", { size: 9 });
        if (c.resolutionNotes?.trim()) d.notesBlock("Resolution", c.resolutionNotes);
        if (c.customerFeedback?.trim() || c.customerRating != null) {
          d.heading("Customer Confirmation");
          if (c.customerRating != null) d.para(`Rating: ${c.customerRating} / 5`, { size: 9 });
          if (c.customerFeedback?.trim()) d.para(c.customerFeedback, { size: 9, color: "muted" });
        }
        if (c.workOrders.length > 0) {
          d.heading("Linked Work Orders");
          d.table(
            [
              { header: "Code", width: 1.6 },
              { header: "Title", width: 3.4 },
              { header: "Status", width: 1.6 },
            ],
            c.workOrders.map((w) => [w.code, w.title, humanize(w.status)])
          );
        }
        if (c.statusHistory.length > 0) {
          d.heading("Status Timeline");
          d.table(
            [
              { header: "When", width: 2 },
              { header: "Transition", width: 2.6 },
              { header: "By", width: 1.8 },
              { header: "Note", width: 2.6 },
            ],
            c.statusHistory.map((h) => [
              fmtDateTime(h.createdAt),
              `${humanize(h.fromStatus)} → ${humanize(h.toStatus)}`,
              (h.changedById && actorNames.get(h.changedById)) || "System",
              h.note || "—",
            ])
          );
        }
      },
    };
  },
};

// ── 3. INSPECTION REPORT (IRMS) ────────────────────────────────────────────

const inspectionReport: DocumentDef = {
  type: "inspection-report",
  docTitle: "Inspection Report",
  permission: PERMISSIONS.irms_read,
  extraPermissions: [PERMISSIONS.irms_portal],
  filenameLabel: "Inspection-Report",
  async load(id, user, branding, origin) {
    const r = await db.inspectionReport.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, code: true, name: true, siteLocation: true, customerId: true, customer: { select: { companyName: true } } } },
        equipment: { select: { name: true, assetTag: true } },
        workOrder: { select: { code: true, title: true } },
        inspector: { select: { employeeNo: true, user: { select: { name: true } } } },
        findings: { orderBy: { id: "asc" } },
        photos: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
        signatures: { orderBy: { signedAt: "desc" as const } },
        approvals: { orderBy: { createdAt: "asc" as const } },
      },
    });
    if (!r) throw Errors.notFound("Inspection report not found.");

    // Customer scoping (contract §14): customers see only their own customer's
    // report, when customerVisible AND status APPROVED|ARCHIVED — others 404.
    if (!isStaff(user.role)) {
      const own =
        r.project.customerId === user.customerId &&
        r.customerVisible &&
        (r.status === "APPROVED" || r.status === "ARCHIVED");
      if (!own) throw Errors.notFound("Inspection report not found.");
    }

    // Photo grid pages are built during render — canonical category order,
    // sortOrder within category, chunked into ≤9-cell pages; DISPLAY variant
    // bytes read from disk sequentially (§52); missing file → placeholder cell.
    const orderedPhotos = canonicalPhotoOrder(r.photos);
    type GridCell = { caption: string; number: string; bytes: Buffer | Uint8Array | null };

    // Latest signature per role, PNG read from disk.
    const signatureItems: { caption: string; name?: string; img?: Buffer | Uint8Array }[] = [];
    for (const role of IRMS_SIGNATURE_ROLES) {
      const s = r.signatures.find((sig) => sig.role === role);
      if (!s) continue;
      const file = await readVariantFile(s.storagePath);
      signatureItems.push({ caption: `${humanize(role)} signature`, name: s.name, img: file?.buffer });
    }
    if (signatureItems.length === 0) {
      signatureItems.push({ caption: "Inspector signature", name: r.inspector?.user.name }, { caption: "Approved by" });
    }

    // QR — same absolute URL as the QR endpoint (§16).
    const qrUrl = `${origin || "http://localhost:3000"}/#/irms/reports/${id}`;
    let qrPng: Buffer | null = null;
    try {
      qrPng = await QRCode.toBuffer(qrUrl, { width: 256, margin: 1, errorCorrectionLevel: "M" });
    } catch {
      qrPng = null; // QR must never fail the document
    }

    return {
      header: {
        company: branding.company,
        contactLines: branding.contactLines,
        docTitle: "Inspection Report",
        docNumber: r.code,
        docDateLabel: `Inspected ${fmtDate(r.inspectionDate)}`,
        meta: [["Status", humanize(r.status)], ["Overall", humanize(r.overallCondition)], ["Revision", `Rev ${r.revision}`]],
      },
      filename: safeFilename(`MOHD-HMS-Inspection-Report-${r.code}.pdf`),
      render: (d) => {
        // Job information (actual DB fields — §17).
        d.kvGrid([
          ["Job Order No", r.jobOrderNo || "—"],
          ["Work Order", r.workOrder ? `${r.workOrder.code} — ${r.workOrder.title}` : "—"],
          ["Work Category", humanize(r.type)],
          ["Start (Completed)", fmtDate(r.inspectionDate)],
          ["Building / Unit", [r.building, r.floor, r.room].filter(Boolean).join(" / ") || "—"],
          ["Site", r.project.siteLocation || "—"],
          ["Report", r.code],
          ["Project", `${r.project.code} — ${r.project.name}`],
          ["Client", r.project.customer?.companyName ?? "—"],
          ["Equipment", r.equipment ? `${r.equipment.name} (${r.equipment.assetTag})` : "—"],
          ["Inspector", r.inspector ? `${r.inspector.user.name} (${r.inspector.employeeNo})` : "—"],
          ["Overall Condition", humanize(r.overallCondition)],
          ["Report Status", humanize(r.status)],
        ]);
        d.spacer(6);
        if (r.taskDescription?.trim()) {
          d.heading("Work Description");
          d.para(r.taskDescription, { size: 9 });
        }
        if (r.summary?.trim()) {
          d.heading("Summary");
          d.para(r.summary, { size: 9 });
        }
        d.heading("Findings");
        d.table(
          [
            { header: "#", width: 0.4, align: "center" },
            { header: "Finding", width: 3.6 },
            { header: "Severity", width: 1.1, align: "center" },
            { header: "Recommended Action", width: 2.6 },
          ],
          r.findings.map((f, i) => [{ text: String(i + 1) }, f.finding, humanize(f.severity), f.recommendation || "—"]),
          { emptyHint: "No findings recorded." }
        );
        // Work details block.
        const workDetails: [string, string][] = [
          ["Scope", r.scope],
          ["Corrective Actions", r.correctiveActions],
          ["Root Cause", r.rootCause],
          ["Safety Notes", r.safetyNotes],
          ["Materials", r.materials],
          ["Notes", r.notes],
        ].filter(([, v]) => (v ?? "").trim().length > 0) as [string, string][];
        if (workDetails.length > 0 || r.labourHours > 0 || r.completionPercent > 0) {
          d.heading("Work Details");
          for (const [label, value] of workDetails) {
            d.para(`${label}: ${value}`, { size: 8.8 });
          }
          d.kvGrid([
            ["Labour Hours", `${r.labourHours} h`],
            ["Completion", `${r.completionPercent}%`],
          ]);
        }
        if (r.recommendations?.trim()) d.notesBlock("Recommendations", r.recommendations);

        // Photo sections + signatures + approval history + QR (async embeds).
        return (async () => {
          for (const category of IRMS_PHOTO_CATEGORIES) {
            const catPhotos = orderedPhotos.filter((p) => p.category === category);
            if (catPhotos.length === 0) continue;
            d.heading(`Photographs — ${humanize(category)}`);
            const chunks: GridCell[][] = [];
            for (let i = 0; i < catPhotos.length; i += 9) {
              const chunk = catPhotos.slice(i, i + 9);
              const cells: GridCell[] = [];
              for (const p of chunk) {
                const file = await readVariantFile(p.displayPath || p.storagePath);
                cells.push({
                  caption: p.caption || [p.room, p.building].filter(Boolean).join(" / "),
                  number: p.photoNo || "—",
                  bytes: file ? file.buffer : null,
                });
              }
              chunks.push(cells);
            }
            await d.photoGrid(chunks);
          }
          d.heading("Signatures");
          await d.signatureImage(signatureItems);
          d.heading("Approval History");
          d.table(
            [
              { header: "Step", width: 1.6 },
              { header: "Transition", width: 2.4 },
              { header: "By", width: 1.8 },
              { header: "Comment", width: 2.2 },
              { header: "Date", width: 1.6 },
            ],
            r.approvals.map((a) => [humanize(a.step), `${humanize(a.fromStatus)} → ${humanize(a.toStatus)}`, a.userName || "—", a.comment || "—", fmtDateTime(a.createdAt)]),
            { emptyHint: "No approval history recorded yet." }
          );
          d.para(`Revision: Rev ${r.revision}${r.clientComment ? ` — Client comment: ${r.clientComment}` : ""}`, { size: 8.2, color: "muted" });
          if (qrPng) await d.qr(qrPng, { caption: `Scan to open ${r.code}` });
        })();
      },
    };
  },
};

// ── 4. QUOTATION ───────────────────────────────────────────────────────────

const quotation: DocumentDef = {
  type: "quotation",
  docTitle: "Quotation",
  permission: PERMISSIONS.quotations_read,
  filenameLabel: "Quotation",
  async load(id, user, branding) {
    const q = await db.quotation.findUnique({
      where: { id },
      include: {
        customer: { select: { code: true, companyName: true, contactPerson: true, email: true, phone: true, address: true, city: true } },
        items: { orderBy: { id: "asc" } },
      },
    });
    if (!q) throw Errors.notFound("Quotation not found.");
    assertVisible(q.customerId, user, "Quotation");

    return {
      header: {
        company: branding.company,
        contactLines: branding.contactLines,
        docTitle: "Quotation",
        docNumber: q.code,
        docDateLabel: `Dated ${fmtDate(q.quotationDate)}`,
        meta: [["Status", humanize(q.status)], ["Valid Until", fmtDate(q.validUntil)]],
      },
      filename: safeFilename(`MOHD-HMS-Quotation-${q.code}.pdf`),
      render: (d) => {
        d.kvGrid([
          ["Quotation", q.code],
          ["Date", fmtDate(q.quotationDate)],
          ["Valid Until", fmtDate(q.validUntil)],
          ["Status", humanize(q.status)],
          ["Customer", q.customer.companyName],
          ["Attention", q.customer.contactPerson || "—"],
          ["Address", [q.customer.address, q.customer.city].filter(Boolean).join(", ") || "—"],
          ["Contact", [q.customer.email, q.customer.phone].filter(Boolean).join(" · ") || "—"],
        ]);
        d.spacer(8);
        d.heading("Itemised Pricing");
        d.table(
          moneyCols(["#", "Description", "Qty", "Unit Rate"]),
          q.items.map((it, i) => [
            { text: String(i + 1) },
            `${it.description}${it.kind ? `  (${humanize(it.kind)})` : ""}`,
            `${qty(it.quantity)} ${it.unit}`.trim(),
            money(it.unitPriceCents),
          ])
        );
        // Backend-authoritative totals (§15) — never recalculated here.
        d.totals([
          ["Subtotal", money(q.subtotalCents)],
          ["Discount", `− ${money(q.discountCents)}`],
          ["Shipping", money(q.shippingCents)],
          ["Tax", money(q.taxCents)],
          [`Grand Total (${q.items.length} item${q.items.length === 1 ? "" : "s"})`, money(q.totalCents)],
        ]);
        d.banner("Currency: BND (Brunei Darussalam). All amounts quoted in Brunei Dollars.");
        if (q.notes?.trim()) d.notesBlock("Notes", q.notes);
        if (q.terms?.trim()) d.notesBlock("Terms & Conditions", q.terms);
        d.signatures([{ caption: "For MOHD.HMS Enterprise" }, { caption: "Customer acceptance" }]);
      },
    };
  },
};

// ── 5. INVOICE ─────────────────────────────────────────────────────────────

const invoice: DocumentDef = {
  type: "invoice",
  docTitle: "Invoice",
  permission: PERMISSIONS.invoices_read,
  filenameLabel: "Invoice",
  async load(id, user, branding) {
    const inv = await db.invoice.findUnique({
      where: { id },
      include: {
        customer: { select: { code: true, companyName: true, contactPerson: true, email: true, phone: true, address: true, city: true } },
        quotation: { select: { code: true } },
        workOrders: { select: { code: true } },
        items: { orderBy: { id: "asc" } },
        payments: { orderBy: { paidAt: "asc" } },
      },
    });
    if (!inv) throw Errors.notFound("Invoice not found.");
    assertVisible(inv.customerId, user, "Invoice");

    return {
      header: {
        company: branding.company,
        contactLines: branding.contactLines,
        docTitle: "Invoice",
        docNumber: inv.code,
        docDateLabel: `Issued ${fmtDate(inv.invoiceDate)}`,
        meta: [["Status", humanize(inv.status)], ["Due", fmtDate(inv.dueDate)]],
      },
      filename: safeFilename(`MOHD-HMS-Invoice-${inv.code}.pdf`),
      render: (d) => {
        d.kvGrid([
          ["Invoice", inv.code],
          ["Invoice Date", fmtDate(inv.invoiceDate)],
          ["Due Date", fmtDate(inv.dueDate)],
          ["Status", humanize(inv.status)],
          ["Bill To", inv.customer.companyName],
          ["Attention", inv.customer.contactPerson || "—"],
          ["Address", [inv.customer.address, inv.customer.city].filter(Boolean).join(", ") || "—"],
          ["Contact", [inv.customer.email, inv.customer.phone].filter(Boolean).join(" · ") || "—"],
          ["Quotation Ref", inv.quotation?.code ?? "—"],
          ["Work Order Ref", inv.workOrders.map((w) => w.code).join(", ") || "—"],
        ]);
        d.spacer(8);
        d.heading("Line Items");
        d.table(
          moneyCols(["#", "Description", "Qty", "Rate"]),
          inv.items.map((it, i) => [
            { text: String(i + 1) },
            `${it.description}${it.kind ? `  (${humanize(it.kind)})` : ""}`,
            `${qty(it.quantity)} ${it.unit}`.trim(),
            money(it.unitPriceCents),
          ])
        );
        // Backend-authoritative totals incl. payments and balance (§16).
        d.totals([
          ["Subtotal", money(inv.subtotalCents)],
          ["Discount", `− ${money(inv.discountCents)}`],
          ["Shipping", money(inv.shippingCents)],
          ["Tax", money(inv.taxCents)],
          ["Total", money(inv.totalCents)],
          ["Amount Paid", money(inv.paidCents)],
          ["Balance Due", money(inv.balanceCents)],
        ]);
        d.banner(
          inv.balanceCents <= 0
            ? "PAID IN FULL — Thank you."
            : `Balance due: ${money(inv.balanceCents)} — payable by ${fmtDate(inv.dueDate)}`,
          inv.balanceCents <= 0 ? "green" : "muted"
        );
        if (inv.payments.length > 0) {
          d.heading("Payments Received");
          d.table(
            [
              { header: "Code", width: 1.5 },
              { header: "Date", width: 1.5 },
              { header: "Method", width: 1.8 },
              { header: "Reference", width: 2 },
              { header: "Amount", width: 1.5, align: "right" },
            ],
            inv.payments.map((p) => [p.code, fmtDate(p.paidAt), humanize(p.method), p.reference || "—", money(p.amountCents)])
          );
        }
        d.banner("Currency: BND (Brunei Darussalam). All amounts in Brunei Dollars.");
        if (inv.notes?.trim()) d.notesBlock("Notes", inv.notes);
        if (inv.terms?.trim()) d.notesBlock("Terms", inv.terms);
      },
    };
  },
};

// ── 6. PURCHASE ORDER ──────────────────────────────────────────────────────

const purchaseOrder: DocumentDef = {
  type: "purchase-order",
  docTitle: "Purchase Order",
  permission: PERMISSIONS.purchases_read,
  filenameLabel: "Purchase-Order",
  async load(id, user, branding) {
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: { select: { code: true, name: true, contactPerson: true, email: true, phone: true, address: true } },
        items: { orderBy: { id: "asc" }, include: { item: { select: { sku: true } } } },
      },
    });
    if (!po) throw Errors.notFound("Purchase order not found.");

    return {
      header: {
        company: branding.company,
        contactLines: branding.contactLines,
        docTitle: "Purchase Order",
        docNumber: po.code,
        docDateLabel: `Ordered ${fmtDate(po.orderDate)}`,
        meta: [["Status", humanize(po.status)]],
      },
      filename: safeFilename(`MOHD-HMS-Purchase-Order-${po.code}.pdf`),
      render: (d) => {
        d.kvGrid([
          ["Purchase Order", po.code],
          ["Order Date", fmtDate(po.orderDate)],
          ["Expected Delivery", fmtDate(po.expectedDate)],
          ["Status", humanize(po.status)],
          ["Supplier", po.supplier.name],
          ["Contact", po.supplier.contactPerson || "—"],
          ["Phone", po.supplier.phone || "—"],
          ["Email", po.supplier.email || "—"],
          ["Supplier Address", po.supplier.address || "—"],
        ]);
        d.spacer(8);
        d.heading("Ordered Items");
        d.table(
          [
            { header: "#", width: 0.4, align: "center" },
            { header: "Description", width: 3.6 },
            { header: "Qty", width: 0.9, align: "center" },
            { header: "Received", width: 1, align: "center" },
            { header: "Unit Cost", width: 1.4, align: "right" },
            { header: "Total", width: 1.4, align: "right" },
          ],
          po.items.map((it, i) => [
            { text: String(i + 1) },
            `${it.description}${it.item?.sku ? `  [${it.item.sku}]` : ""}`,
            qty(it.quantity),
            qty(it.receivedQty),
            money(it.unitCostCents),
            money(it.totalCents),
          ])
        );
        d.totals([
          ["Subtotal", money(po.subtotalCents)],
          ["Tax", money(po.taxCents)],
          ["Grand Total", money(po.totalCents)],
        ]);
        d.banner("Currency: BND (Brunei Darussalam). All amounts in Brunei Dollars.");
        if (po.approvedAt) d.para(`Approved on ${fmtDateTime(po.approvedAt)}`, { size: 8.5, color: "muted" });
        if (po.notes?.trim()) d.notesBlock("Notes", po.notes);
        d.signatures([{ caption: "Approved by" }, { caption: "Received by" }]);
      },
    };
  },
};

// ── 7. EQUIPMENT REPORT ────────────────────────────────────────────────────

const equipmentReport: DocumentDef = {
  type: "equipment-report",
  docTitle: "Equipment Report",
  permission: PERMISSIONS.equipment_read,
  filenameLabel: "Equipment-Report",
  async load(id, user, branding) {
    const e = await db.equipment.findUnique({
      where: { id },
      include: {
        location: { select: { name: true, code: true } },
        customer: { select: { code: true, companyName: true } },
        pmPlans: { select: { code: true, name: true, frequency: true, nextDueDate: true, active: true } },
        workOrders: { orderBy: { createdAt: "desc" }, take: 8, select: { code: true, title: true, status: true, createdAt: true } },
        complaints: { orderBy: { createdAt: "desc" }, take: 8, select: { code: true, title: true, status: true, createdAt: true } },
      },
    });
    if (!e) throw Errors.notFound("Equipment not found.");
    assertVisible(e.customerId, user, "Equipment");

    return {
      header: {
        company: branding.company,
        contactLines: branding.contactLines,
        docTitle: "Equipment Report",
        docNumber: e.assetTag,
        docDateLabel: `Generated ${fmtDate(new Date())}`,
        meta: [["Status", humanize(e.status)]],
      },
      filename: safeFilename(`MOHD-HMS-Equipment-Report-${e.assetTag}.pdf`),
      render: (d) => {
        d.kvGrid([
          ["Asset Tag", e.assetTag],
          ["Name", e.name],
          ["Category", humanize(e.category)],
          ["Status", humanize(e.status)],
          ["Manufacturer", e.manufacturer || "—"],
          ["Model", e.model || "—"],
          ["Serial Number", e.serialNumber || "—"],
          ["Location", e.location ? `${e.location.name} (${e.location.code})` : "—"],
          ["Customer", e.customer?.companyName ?? "—"],
          ["Installed", fmtDate(e.installationDate)],
          ["Warranty Expiry", fmtDate(e.warrantyExpiry)],
          ["PM Frequency", `${e.pmFrequencyDays} days`],
        ]);
        if (e.notes?.trim()) d.notesBlock("Notes", e.notes);
        if (e.pmPlans.length > 0) {
          d.heading("Preventive Maintenance Plans");
          d.table(
            [
              { header: "Code", width: 1.5 },
              { header: "Plan", width: 3 },
              { header: "Frequency", width: 1.4 },
              { header: "Next Due", width: 1.4 },
              { header: "State", width: 1.1, align: "center" },
            ],
            e.pmPlans.map((p) => [p.code, p.name, humanize(p.frequency), fmtDate(p.nextDueDate), p.active ? "Active" : "Inactive"])
          );
        }
        if (e.workOrders.length > 0) {
          d.heading("Recent Work Orders");
          d.table(
            [
              { header: "Code", width: 1.5 },
              { header: "Title", width: 3.4 },
              { header: "Status", width: 1.4 },
              { header: "Created", width: 1.5 },
            ],
            e.workOrders.map((w) => [w.code, w.title, humanize(w.status), fmtDate(w.createdAt)])
          );
        }
        if (e.complaints.length > 0) {
          d.heading("Recent Complaints");
          d.table(
            [
              { header: "Code", width: 1.5 },
              { header: "Title", width: 3.4 },
              { header: "Status", width: 1.4 },
              { header: "Created", width: 1.5 },
            ],
            e.complaints.map((c) => [c.code, c.title, humanize(c.status), fmtDate(c.createdAt)])
          );
        }
      },
    };
  },
};

// ── 8. PM TASK (Preventive Maintenance service sheet) ──────────────────────

const pmTask: DocumentDef = {
  type: "pm-task",
  docTitle: "PM Service Sheet",
  permission: PERMISSIONS.pm_read,
  filenameLabel: "PM-Task",
  async load(id, user, branding) {
    const t = await db.pmTask.findUnique({
      where: { id },
      include: {
        plan: { select: { code: true, name: true, frequency: true } },
        equipment: { select: { name: true, assetTag: true, location: { select: { name: true } } } },
        technician: { select: { employeeNo: true, user: { select: { name: true } } } },
        checklist: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!t) throw Errors.notFound("PM task not found.");

    const done = t.checklist.filter((c) => c.done).length;
    return {
      header: {
        company: branding.company,
        contactLines: branding.contactLines,
        docTitle: "PM Service Sheet",
        docNumber: t.code,
        docDateLabel: `Due ${fmtDate(t.dueDate)}`,
        meta: [["Status", humanize(t.status)]],
      },
      filename: safeFilename(`MOHD-HMS-PM-Task-${t.code}.pdf`),
      render: (d) => {
        d.kvGrid([
          ["Task", t.code],
          ["Status", humanize(t.status)],
          ["Plan", `${t.plan.code} — ${t.plan.name}`],
          ["Frequency", humanize(t.plan.frequency)],
          ["Equipment", `${t.equipment.name} (${t.equipment.assetTag})`],
          ["Location", t.equipment.location?.name ?? "—"],
          ["Assigned Technician", t.technician ? `${t.technician.user.name} (${t.technician.employeeNo})` : "Unassigned"],
          ["Due Date", fmtDate(t.dueDate)],
          ["Completed", fmtDateTime(t.completedAt)],
          ["Progress", t.checklist.length > 0 ? `${done} / ${t.checklist.length} items done` : "—"],
        ]);
        d.spacer(6);
        if (t.checklist.length > 0) {
          d.heading("Service Checklist");
          d.table(
            [
              { header: "#", width: 0.4, align: "center" },
              { header: "Checklist Item", width: 4.6 },
              { header: "Result", width: 1.4, align: "center" },
            ],
            t.checklist.map((c, i) => [{ text: String(i + 1) }, c.label, c.done ? "Done" : "Pending"])
          );
        }
        if (t.notes?.trim()) d.notesBlock("Technician Notes", t.notes);
        d.signatures([{ caption: "Technician signature", name: t.technician?.user.name }, { caption: "Supervisor review" }]);
      },
    };
  },
};

// ── 9. PAYMENT RECEIPT ─────────────────────────────────────────────────────

const paymentReceipt: DocumentDef = {
  type: "payment-receipt",
  docTitle: "Payment Receipt",
  permission: PERMISSIONS.payments_read,
  filenameLabel: "Payment-Receipt",
  async load(id, user, branding) {
    const p = await db.payment.findUnique({
      where: { id },
      include: {
        invoice: {
          select: { code: true, customerId: true, invoiceDate: true, totalCents: true, paidCents: true, balanceCents: true, status: true, customer: { select: { companyName: true, contactPerson: true } } },
        },
        customer: { select: { companyName: true } },
      },
    });
    if (!p) throw Errors.notFound("Payment not found.");
    // Customer-portal visibility follows the invoice owner (receipts are
    // financial documents; the payer is resolved via the invoice customer).
    const scopeCustomerId = p.customerId ?? p.invoice?.customerId ?? null;
    assertVisible(scopeCustomerId, user, "Payment");

    const recorder = p.recordedById
      ? await db.user.findUnique({ where: { id: p.recordedById }, select: { name: true } })
      : null;

    const inv = p.invoice;
    return {
      header: {
        company: branding.company,
        contactLines: branding.contactLines,
        docTitle: "Payment Receipt",
        docNumber: p.code,
        docDateLabel: `Received ${fmtDate(p.paidAt)}`,
        meta: [["Method", humanize(p.method)]],
      },
      filename: safeFilename(`MOHD-HMS-Payment-Receipt-${p.code}.pdf`),
      render: (d) => {
        d.banner(`Payment received with thanks — ${money(p.amountCents)}`, "green");
        d.kvGrid([
          ["Receipt", p.code],
          ["Date", fmtDate(p.paidAt)],
          ["Payment Method", humanize(p.method)],
          ["Reference", p.reference || "—"],
          ["Received From", p.customer?.companyName ?? inv?.customer.companyName ?? "—"],
          ["Invoice", inv?.code ?? "—"],
          ["Invoice Status", inv ? humanize(inv.status) : "—"],
          ["Recorded By", recorder?.name ?? "—"],
        ]);
        if (inv) {
          d.spacer(8);
          d.heading("Invoice Position After This Payment");
          d.totals([
            ["Invoice total", money(inv.totalCents)],
            ["Total paid to date", money(inv.paidCents)],
            ["Balance remaining", money(inv.balanceCents)],
          ]);
        }
        if (p.note?.trim()) d.notesBlock("Remarks", p.note);
        d.banner("Currency: BND (Brunei Darussalam). All amounts in Brunei Dollars.");
        d.signatures([{ caption: "For MOHD.HMS Enterprise" }, { caption: "Payer acknowledgement" }]);
      },
    };
  },
};

// ── registry + dispatcher ──────────────────────────────────────────────────

export const DOCUMENT_TYPES: DocumentDef[] = [
  workOrder,
  complaint,
  inspectionReport,
  quotation,
  invoice,
  purchaseOrder,
  equipmentReport,
  pmTask,
  paymentReceipt,
];

export function findDocumentType(type: string): DocumentDef | undefined {
  return DOCUMENT_TYPES.find((t) => t.type === type);
}

/** Load → render → validate (§7 steps 5–8, §20). Central pipeline for all docs. */
export async function buildDocument(def: DocumentDef, id: string, user: PdfRequestUser, branding?: Branding, origin?: string): Promise<BuiltDoc> {
  const { getBranding } = await import("./branding");
  const brand = branding ?? (await getBranding());
  const loaded = await def.load(id, user, brand, origin);
  const doc = await PdfDoc.create(loaded.header, brand.logoBytes);
  await loaded.render(doc);
  const { bytes, pageCount } = await doc.build();
  return {
    bytes,
    pageCount,
    filename: loaded.filename || safeFilename(`${def.filenameLabel}-${id}.pdf`),
    docTitle: def.docTitle,
    docNumber: loaded.header.docNumber,
  };
}
