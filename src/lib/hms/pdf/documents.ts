// MOHD.HMS ENTERPRISE — Centralized document type registry (§6) + builders.
//
// ONE registry maps every existing business document to:
//   permission (§21 RBAC)  →  loader (§12 authoritative Prisma data,
//   customer-scoped)  →  BLOCK RENDERERS (central PdfDoc engine)  →  filename.
//
// Routes never contain rendering code; they dispatch through this registry.
// All money passes through the central BND formatters in @/lib/hms/format.
// Only fields that actually exist in the database are included (§12).
//
// TEMPLATE SYSTEM (Settings → Templates, spec §10/§43/§44/§45): every renderer
// is decomposed into named, reorderable BLOCKS (the canonical order IS the
// historical built-in layout). A template contributes (a) a block order +
// heading overrides + safe per-block config (layout) and (b) style (colors,
// fonts, geometry). Business data ALWAYS comes from the loaders below —
// templates never query the database and never contain executable code (§46).
// With no template resolved, the canonical plan renders byte-equivalently to
// the historical layout (§55 — existing documents keep working).

import "server-only";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { isStaff } from "@/lib/hms/rbac";
import { PERMISSIONS, IRMS_PHOTO_CATEGORIES, IRMS_SIGNATURE_ROLES, humanize, type Permission } from "@/lib/hms/constants";
import { fmtDate, fmtDateTime, money, customerLabel } from "@/lib/hms/format";
import { PdfDoc, safeFilename, type DocHeaderInfo, type TableCol, type TableCell } from "./engine";
import { canonicalPhotoOrder, readVariantFile } from "@/lib/hms/irms/storage";
import type { Branding } from "./branding";
import { pdfQrBadge } from "@/lib/hms/qr/service";
import {
  BLOCK_META,
  substituteVars,
  type TemplateType,
  type TemplateLayout,
  type BlockMeta,
} from "./template-meta";
import type { TemplateStyle } from "./template-style";
import { resolveTemplateForDocument, recordTemplateSnapshot, type ResolvedTemplate } from "@/lib/hms/templates/service";
import { sampleContext } from "./samples";

export type PdfRequestUser = { id: string; role: string; customerId: string | null };

// ── block-plan types (§10 — controlled component model) ─────────────────────

export type BlockCtx = {
  /** The authoritative business payload loaded by `load` (typed per document). */
  data: Record<string, unknown>;
  /** Central QR verification badge (png + reference) — from QRService. */
  qr: { png: Buffer | Uint8Array; reference: string } | null;
  /** Safe variable values for {{substitution}} in custom text blocks (§45). */
  vars: Record<string, string>;
};

export type BlockOpts = { heading?: string; config: Record<string, unknown> };
export type BlockRenderer = (d: PdfDoc, ctx: BlockCtx, opts: BlockOpts) => void | Promise<void>;

type Loaded = {
  header: DocHeaderInfo;
  filename: string;
  ctx: BlockCtx;
};

export type DocumentDef = {
  type: string; // URL segment: /api/v1/pdf/{type}/{id} — also the templateType key
  docTitle: string;
  permission: Permission;
  /** Additional permissions that ALSO grant access (e.g. irms.portal lets a
   *  customer download their own shared/approved inspection reports — the
   *  loader still enforces customer scoping, so this never widens visibility). */
  extraPermissions?: Permission[];
  filenameLabel: string; // §23 filename middle segment
  blocks: DocumentBlockDef[];
  load: (id: string, user: PdfRequestUser, branding: Branding, origin?: string) => Promise<Loaded>;
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

/** Optional heading helper — blocks honour template heading overrides (§10). */
const h = (opts: BlockOpts, fallback: string): string => (opts.heading?.trim() ? opts.heading.trim() : fallback);

/** The optional Custom Text block (shared renderer for every document type) —
 *  the ONLY place {{variables}} are substituted (§12/§13/§45). */
const renderCustomText: BlockRenderer = (d, ctx, opts) => {
  const text = String(opts.config.text ?? "");
  if (!text.trim()) return;
  d.heading(h(opts, "Notes"), { keepWithNext: 24 });
  d.para(substituteVars(text, ctx.vars), { size: 9 });
};

const renderQr: BlockRenderer = async (d, ctx) => {
  if (ctx.qr) await d.qr(ctx.qr.png, { reference: ctx.qr.reference });
};

// ── 1. WORK ORDER ──────────────────────────────────────────────────────────

type WoRow = {
  code: string; title: string | null; description: string | null; status: string; priority: string;
  notes: string | null; customerConfirmed: boolean; confirmedAt: Date | null;
  scheduledDate: Date | null; startedAt: Date | null; completedAt: Date | null;
  labourTotalCents: number; labourHours: number; labourRateCents: number; materialsTotalCents: number; totalCents: number;
  complaint: { code: string; title: string } | null;
  customer: { code: string; companyName: string; contactPerson: string; phone: string; address: string; city: string };
  equipment: { name: string; assetTag: string; serialNumber: string } | null;
  technician: { employeeNo: string; user: { name: string } } | null;
  checklist: { required: boolean; label: string; unit: string | null; responseType: string; done: boolean; response: string | null; notes: string | null; origin: string | null }[];
  materials: { name: string; quantity: number; unit: string | null; unitCostCents: number; totalCents: number }[];
};

const workOrderRenderers: Record<string, BlockRenderer> = {
  summary: (d, ctx, opts) => {
    const wo = ctx.data as unknown as WoRow;
    if (opts.heading?.trim()) d.heading(opts.heading.trim());
    d.kvGrid([
      ["Work Order", wo.code],
      ["Status", humanize(wo.status)],
      ["Priority", humanize(wo.priority)],
      ["Customer", customerLabel(wo.customer)],
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
  },
  description: (d, ctx) => {
    const wo = ctx.data as unknown as WoRow;
    d.heading("Description");
    d.para(wo.description || wo.title || "—", { size: 9 });
  },
  checklist: (d, ctx) => {
    const wo = ctx.data as unknown as WoRow;
    if (wo.checklist.length === 0) return;
    d.heading("Checklist");
    // Checklist engine §34/§65 — results, response types and technician
    // notes are rendered (the engine's structured fields feed the report).
    d.table(
      [
        { header: "#", width: 0.35, align: "center" },
        { header: "Task", width: 2.75 },
        { header: "Type", width: 0.75, align: "center" },
        { header: "Result", width: 1.35 },
        { header: "Notes", width: 1.45 },
      ],
      wo.checklist.map((c, i) => [
        { text: String(i + 1) },
        `${c.required ? "* " : ""}${c.label}${c.unit && c.responseType === "NUMERIC" ? ` (${c.unit})` : ""}`,
        { text: humanize(c.responseType), align: "center" },
        (() => {
          const result = c.done
            ? c.responseType === "CHECKBOX"
              ? "Done"
              : c.response || "Recorded"
            : "Pending";
          return { text: result };
        })(),
        c.notes ? c.notes : "",
      ])
    );
    const originLine = wo.checklist.find((c) => c.origin && c.origin !== "MANUAL")?.origin;
    if (originLine) {
      d.banner(`Checklist origin: ${humanize(originLine)} (structured checklist engine)`, "muted");
    }
  },
  "labour-materials": (d, ctx) => {
    const wo = ctx.data as unknown as WoRow;
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
  },
  totals: (d, ctx) => {
    const wo = ctx.data as unknown as WoRow;
    d.totals([
      ["Labour total", money(wo.labourTotalCents)],
      ["Materials total", money(wo.materialsTotalCents)],
      ["Grand total", money(wo.totalCents)],
    ]);
  },
  notes: (d, ctx) => {
    const wo = ctx.data as unknown as WoRow;
    if (wo.notes?.trim()) d.notesBlock("Notes", wo.notes);
  },
  confirmation: (d, ctx) => {
    const wo = ctx.data as unknown as WoRow;
    d.banner(wo.customerConfirmed ? `Customer confirmed on ${fmtDate(wo.confirmedAt)}` : "Customer confirmation pending", wo.customerConfirmed ? "green" : "muted");
  },
  signatures: (d) => {
    d.signatures([{ caption: "Technician signature" }, { caption: "Customer signature" }]);
  },
  qr: renderQr,
  "custom-text": renderCustomText,
};

const workOrder: DocumentDef = {
  type: "work-order",
  docTitle: "Work Order",
  permission: PERMISSIONS.work_orders_read,
  filenameLabel: "Work-Order",
  blocks: [],
  async load(id, user, branding, origin) {
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

    // Central verification QR (ch.35 §16-§21) — ONE hook, identity created
    // once and reused across every regeneration (§12/§33).
    const qr = await pdfQrBadge("WORK_ORDER", id, { status: wo.status, origin, reference: wo.code });

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
      ctx: {
        data: wo,
        qr: qr ? { png: qr.png, reference: qr.reference } : null,
        vars: {
          work_order_number: wo.code,
          status: humanize(wo.status),
          priority: humanize(wo.priority),
          customer_name: customerLabel(wo.customer),
          equipment: wo.equipment ? `${wo.equipment.name} (${wo.equipment.assetTag})` : "—",
          technician: wo.technician ? `${wo.technician.user.name} (${wo.technician.employeeNo})` : "Unassigned",
          scheduled_date: fmtDate(wo.scheduledDate),
          total: money(wo.totalCents),
          company_name: branding.company,
        },
      },
    };
  },
};

// ── 2. COMPLAINT ───────────────────────────────────────────────────────────

type ComplaintRow = {
  code: string; status: string; priority: string; description: string | null;
  resolutionNotes: string | null; customerFeedback: string | null; customerRating: number | null;
  createdAt: Date; assignedAt: Date | null; startedAt: Date | null; completedAt: Date | null; closedAt: Date | null;
  customer: { code: string; companyName: string; contactPerson: string; phone: string };
  equipment: { name: string; assetTag: string } | null;
  assignedTechnician: { employeeNo: string; user: { name: string } } | null;
  statusHistory: { createdAt: Date; fromStatus: string; toStatus: string; changedById: string | null; note: string | null }[];
  workOrders: { code: string; title: string; status: string }[];
};

const complaintRenderers: Record<string, BlockRenderer> = {
  summary: (d, ctx, opts) => {
    const c = ctx.data.complaint as unknown as ComplaintRow;
    if (opts.heading?.trim()) d.heading(opts.heading.trim());
    d.kvGrid([
      ["Complaint", c.code],
      ["Status", humanize(c.status)],
      ["Priority", humanize(c.priority)],
      ["Customer", customerLabel(c.customer)],
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
  },
  description: (d, ctx) => {
    const c = ctx.data.complaint as unknown as ComplaintRow;
    d.heading("Description");
    d.para(c.description || "—", { size: 9 });
  },
  resolution: (d, ctx) => {
    const c = ctx.data.complaint as unknown as ComplaintRow;
    if (c.resolutionNotes?.trim()) d.notesBlock("Resolution", c.resolutionNotes);
  },
  "customer-confirmation": (d, ctx) => {
    const c = ctx.data.complaint as unknown as ComplaintRow;
    if (c.customerFeedback?.trim() || c.customerRating != null) {
      d.heading("Customer Confirmation");
      if (c.customerRating != null) d.para(`Rating: ${c.customerRating} / 5`, { size: 9 });
      if (c.customerFeedback?.trim()) d.para(c.customerFeedback, { size: 9, color: "muted" });
    }
  },
  "linked-work-orders": (d, ctx) => {
    const c = ctx.data.complaint as unknown as ComplaintRow;
    if (c.workOrders.length === 0) return;
    d.heading("Linked Work Orders");
    d.table(
      [
        { header: "Code", width: 1.6 },
        { header: "Title", width: 3.4 },
        { header: "Status", width: 1.6 },
      ],
      c.workOrders.map((w) => [w.code, w.title, humanize(w.status)])
    );
  },
  "status-timeline": (d, ctx) => {
    const c = ctx.data.complaint as unknown as ComplaintRow;
    if (c.statusHistory.length === 0) return;
    const actorNames = ctx.data.actorNames as Map<string, string>;
    d.heading("Status Timeline");
    d.table(
      [
        { header: "When", width: 2 },
        { header: "Transition", width: 2.6 },
        { header: "By", width: 1.8 },
        { header: "Note", width: 2.6 },
      ],
      c.statusHistory.map((hh) => [
        fmtDateTime(hh.createdAt),
        `${humanize(hh.fromStatus)} → ${humanize(hh.toStatus)}`,
        (hh.changedById && actorNames.get(hh.changedById)) || "System",
        hh.note || "—",
      ])
    );
  },
  qr: renderQr,
  "custom-text": renderCustomText,
};

const complaint: DocumentDef = {
  type: "complaint",
  docTitle: "Complaint Report",
  permission: PERMISSIONS.complaints_read,
  filenameLabel: "Complaint",
  blocks: [],
  async load(id, user, branding, origin) {
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

    const qr = await pdfQrBadge("COMPLAINT", id, { status: c.status, origin, reference: c.code });

    // Resolve timeline actor names in one query (changedById is a bare string).
    const actorIds = [...new Set(c.statusHistory.map((hh) => hh.changedById).filter((v): v is string => !!v))];
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
      ctx: {
        data: { complaint: c, actorNames },
        qr: qr ? { png: qr.png, reference: qr.reference } : null,
        vars: {
          complaint_number: c.code,
          status: humanize(c.status),
          priority: humanize(c.priority),
          customer_name: customerLabel(c.customer),
          equipment: c.equipment ? `${c.equipment.name} (${c.equipment.assetTag})` : "—",
          technician: c.assignedTechnician ? `${c.assignedTechnician.user.name} (${c.assignedTechnician.employeeNo})` : "Unassigned",
          company_name: branding.company,
        },
      },
    };
  },
};

// ── 3. INSPECTION REPORT (IRMS) ────────────────────────────────────────────

type IrmsRow = {
  code: string; status: string; overallCondition: string; revision: number; clientComment: string | null;
  jobOrderNo: string | null; type: string; inspectionDate: Date; building: string | null; floor: string | null; room: string | null;
  taskDescription: string | null; summary: string | null; scope: string | null; correctiveActions: string | null;
  rootCause: string | null; safetyNotes: string | null; materials: string | null; notes: string | null;
  labourHours: number; completionPercent: number; recommendations: string | null; customerVisible: boolean;
  project: { id: string; code: string; name: string; siteLocation: string; customerId: string; customer: { companyName: string; contactPerson: string } };
  equipment: { name: string; assetTag: string } | null;
  workOrder: { code: string; title: string } | null;
  inspector: { employeeNo: string; user: { name: string } } | null;
  findings: { finding: string; severity: string; recommendation: string | null }[];
  photos: Parameters<typeof canonicalPhotoOrder>[0];
  approvals: { step: string; fromStatus: string; toStatus: string; userName: string | null; comment: string | null; createdAt: Date }[];
};

type IrmsData = { row: IrmsRow; signatureItems: { caption: string; name?: string; img?: Buffer | Uint8Array }[] };

/** Photo page-groups for ONE category (file bytes read here, in the block —
 *  ≤9 cells per group; the engine owns all placement, §14/§21). */
async function irmPhotoPages(r: IrmsRow, category: string, cols: number) {
  const catPhotos = canonicalPhotoOrder(r.photos).filter((p) => p.category === category);
  if (catPhotos.length === 0) return null;
  const perPage = Math.min(9, Math.max(3, cols) * 3);
  const chunks: { caption: string; number: string; bytes: Buffer | Uint8Array | null }[][] = [];
  for (let i = 0; i < catPhotos.length; i += perPage) {
    const chunk = catPhotos.slice(i, i + perPage);
    const cells: { caption: string; number: string; bytes: Buffer | Uint8Array | null }[] = [];
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
  return chunks;
}

const irmPhotoBlock = (category: string): BlockRenderer => async (d, ctx, opts) => {
  const { row } = ctx.data as unknown as IrmsData;
  const cols = Math.min(4, Math.max(1, parseInt(String(opts.config.columns ?? 3), 10) || 3));
  const pages = await irmPhotoPages(row, category, cols);
  if (!pages) return;
  await d.photoGrid(pages, { heading: h(opts, `Photographs — ${humanize(category)}`), cols });
};

const inspectionReportRenderers: Record<string, BlockRenderer> = {
  "job-info": (d, ctx, opts) => {
    const { row: r } = ctx.data as unknown as IrmsData;
    if (opts.heading?.trim()) d.heading(opts.heading.trim());
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
      ["Client", customerLabel(r.project.customer)],
      ["Equipment", r.equipment ? `${r.equipment.name} (${r.equipment.assetTag})` : "—"],
      ["Inspector", r.inspector ? `${r.inspector.user.name} (${r.inspector.employeeNo})` : "—"],
      ["Overall Condition", humanize(r.overallCondition)],
      ["Report Status", humanize(r.status)],
    ]);
    d.spacer(6);
  },
  "work-description": (d, ctx) => {
    const { row: r } = ctx.data as unknown as IrmsData;
    if (r.taskDescription?.trim()) {
      d.heading("Work Description", { keepWithNext: 24 });
      d.para(r.taskDescription, { size: 9 });
    }
  },
  summary: (d, ctx) => {
    const { row: r } = ctx.data as unknown as IrmsData;
    if (r.summary?.trim()) {
      d.heading("Summary", { keepWithNext: 24 });
      d.para(r.summary, { size: 9 });
    }
  },
  findings: (d, ctx) => {
    const { row: r } = ctx.data as unknown as IrmsData;
    d.heading("Findings", { keepWithNext: 48 });
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
  },
  "work-details": (d, ctx) => {
    const { row: r } = ctx.data as unknown as IrmsData;
    const workDetails: [string, string][] = (
      [
        ["Scope", r.scope],
        ["Corrective Actions", r.correctiveActions],
        ["Root Cause", r.rootCause],
        ["Safety Notes", r.safetyNotes],
        ["Materials", r.materials],
        ["Notes", r.notes],
      ] as [string, string | null][]
    ).filter(([, v]) => (v ?? "").trim().length > 0) as [string, string][];
    if (workDetails.length > 0 || r.labourHours > 0 || r.completionPercent > 0) {
      d.heading("Work Details", { keepWithNext: 24 });
      for (const [label, value] of workDetails) {
        d.para(`${label}: ${value}`, { size: 8.8 });
      }
      d.kvGrid([
        ["Labour Hours", `${r.labourHours} h`],
        ["Completion", `${r.completionPercent}%`],
      ]);
    }
  },
  recommendations: (d, ctx) => {
    const { row: r } = ctx.data as unknown as IrmsData;
    if (r.recommendations?.trim()) d.notesBlock("Recommendations", r.recommendations);
  },
  "photos-before": irmPhotoBlock("BEFORE"),
  "photos-during": irmPhotoBlock("DURING"),
  "photos-after": irmPhotoBlock("AFTER"),
  signatures: async (d, ctx, opts) => {
    const { signatureItems } = ctx.data as unknown as IrmsData;
    d.heading(h(opts, "Signatures"), { keepWithNext: 92 });
    await d.signatureImage(signatureItems);
  },
  "approval-history": (d, ctx) => {
    const { row: r } = ctx.data as unknown as IrmsData;
    d.heading("Approval History", { keepWithNext: 48 });
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
  },
  "revision-note": (d, ctx) => {
    const { row: r } = ctx.data as unknown as IrmsData;
    d.para(`Revision: Rev ${r.revision}${r.clientComment ? ` — Client comment: ${r.clientComment}` : ""}`, { size: 8.2, color: "muted" });
  },
  qr: renderQr,
  "custom-text": renderCustomText,
};

const inspectionReport: DocumentDef = {
  type: "inspection-report",
  docTitle: "Inspection Report",
  permission: PERMISSIONS.irms_read,
  extraPermissions: [PERMISSIONS.irms_portal],
  filenameLabel: "Inspection-Report",
  blocks: [],
  async load(id, user, branding, origin) {
    const r = await db.inspectionReport.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, code: true, name: true, siteLocation: true, customerId: true, customer: { select: { companyName: true, contactPerson: true } } } },
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

    // QR — centralized verification identity (ch.35 §20): the SAME canonical
    // token the public verifier resolves, replacing the previous inline
    // deep-link QR (§67: no separate QR logic inside IRMS). Created only for
    // final APPROVED/ARCHIVED reports (§61).
    const qr = await pdfQrBadge("INSPECTION_REPORT", id, { status: r.status, origin, reference: r.code });

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
      ctx: {
        data: { row: r, signatureItems },
        qr: qr ? { png: qr.png, reference: qr.reference } : null,
        vars: {
          inspection_number: r.code,
          project_number: r.project.code,
          project_name: r.project.name,
          client: customerLabel(r.project.customer),
          equipment: r.equipment ? `${r.equipment.name} (${r.equipment.assetTag})` : "—",
          inspector: r.inspector ? `${r.inspector.user.name} (${r.inspector.employeeNo})` : "—",
          inspection_date: fmtDate(r.inspectionDate),
          status: humanize(r.status),
          overall_condition: humanize(r.overallCondition),
          revision: `Rev ${r.revision}`,
          finding_count: String(r.findings.length),
          company_name: branding.company,
        },
      },
    };
  },
};

// ── 4. QUOTATION ───────────────────────────────────────────────────────────

type QuotationRow = {
  code: string; status: string; quotationDate: Date; validUntil: Date | null;
  subtotalCents: number; discountCents: number; shippingCents: number; taxCents: number; totalCents: number;
  notes: string | null; terms: string | null;
  customer: { code: string; companyName: string; contactPerson: string; email: string; phone: string; address: string; city: string };
  items: { description: string; kind: string | null; quantity: number; unit: string; unitPriceCents: number }[];
};

const quotationRenderers: Record<string, BlockRenderer> = {
  summary: (d, ctx, opts) => {
    const q = ctx.data as unknown as QuotationRow;
    if (opts.heading?.trim()) d.heading(opts.heading.trim());
    d.kvGrid([
      ["Quotation", q.code],
      ["Date", fmtDate(q.quotationDate)],
      ["Valid Until", fmtDate(q.validUntil)],
      ["Status", humanize(q.status)],
      ["Customer", customerLabel(q.customer)],
      ["Attention", q.customer.contactPerson || "—"],
      ["Address", [q.customer.address, q.customer.city].filter(Boolean).join(", ") || "—"],
      ["Contact", [q.customer.email, q.customer.phone].filter(Boolean).join(" · ") || "—"],
    ]);
    d.spacer(8);
  },
  items: (d, ctx) => {
    const q = ctx.data as unknown as QuotationRow;
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
  },
  totals: (d, ctx) => {
    const q = ctx.data as unknown as QuotationRow;
    // Backend-authoritative totals (§15) — never recalculated here.
    d.totals([
      ["Subtotal", money(q.subtotalCents)],
      ["Discount", `− ${money(q.discountCents)}`],
      ["Shipping", money(q.shippingCents)],
      ["Tax", money(q.taxCents)],
      [`Grand Total (${q.items.length} item${q.items.length === 1 ? "" : "s"})`, money(q.totalCents)],
    ]);
  },
  "currency-banner": (d) => {
    d.banner("Currency: BND (Brunei Darussalam). All amounts quoted in Brunei Dollars.");
  },
  notes: (d, ctx) => {
    const q = ctx.data as unknown as QuotationRow;
    if (q.notes?.trim()) d.notesBlock("Notes", q.notes);
  },
  terms: (d, ctx) => {
    const q = ctx.data as unknown as QuotationRow;
    if (q.terms?.trim()) d.notesBlock("Terms & Conditions", q.terms);
  },
  signatures: (d) => {
    d.signatures([{ caption: "For MOHD.HMS Enterprise" }, { caption: "Customer acceptance" }]);
  },
  qr: renderQr,
  "custom-text": renderCustomText,
};

const quotation: DocumentDef = {
  type: "quotation",
  docTitle: "Quotation",
  permission: PERMISSIONS.quotations_read,
  filenameLabel: "Quotation",
  blocks: [],
  async load(id, user, branding, origin) {
    const q = await db.quotation.findUnique({
      where: { id },
      include: {
        customer: { select: { code: true, companyName: true, contactPerson: true, email: true, phone: true, address: true, city: true } },
        items: { orderBy: { id: "asc" } },
      },
    });
    if (!q) throw Errors.notFound("Quotation not found.");
    assertVisible(q.customerId, user, "Quotation");

    const qr = await pdfQrBadge("QUOTATION", id, { status: q.status, origin, reference: q.code });

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
      ctx: {
        data: q,
        qr: qr ? { png: qr.png, reference: qr.reference } : null,
        vars: {
          quotation_number: q.code,
          quotation_date: fmtDate(q.quotationDate),
          valid_until: fmtDate(q.validUntil),
          status: humanize(q.status),
          customer_name: customerLabel(q.customer),
          customer_address: [q.customer.address, q.customer.city].filter(Boolean).join(", ") || "—",
          customer_contact: [q.customer.contactPerson, q.customer.email, q.customer.phone].filter(Boolean).join(" · ") || "—",
          item_count: String(q.items.length),
          subtotal: money(q.subtotalCents),
          discount: money(q.discountCents),
          shipping: money(q.shippingCents),
          tax: money(q.taxCents),
          total: money(q.totalCents),
          company_name: branding.company,
        },
      },
    };
  },
};

// ── 5. INVOICE ─────────────────────────────────────────────────────────────

type InvoiceRow = {
  code: string; status: string; invoiceDate: Date; dueDate: Date | null;
  subtotalCents: number; discountCents: number; shippingCents: number; taxCents: number;
  totalCents: number; paidCents: number; balanceCents: number;
  notes: string | null; terms: string | null;
  customer: { code: string; companyName: string; contactPerson: string; email: string; phone: string; address: string; city: string };
  quotation: { code: string } | null;
  workOrders: { code: string }[];
  items: { description: string; kind: string | null; quantity: number; unit: string; unitPriceCents: number }[];
  payments: { code: string; paidAt: Date; method: string; reference: string | null; amountCents: number }[];
};

const invoiceRenderers: Record<string, BlockRenderer> = {
  summary: (d, ctx, opts) => {
    const inv = ctx.data as unknown as InvoiceRow;
    if (opts.heading?.trim()) d.heading(opts.heading.trim());
    d.kvGrid([
      ["Invoice", inv.code],
      ["Invoice Date", fmtDate(inv.invoiceDate)],
      ["Due Date", fmtDate(inv.dueDate)],
      ["Status", humanize(inv.status)],
      ["Bill To", customerLabel(inv.customer)],
      ["Attention", inv.customer.contactPerson || "—"],
      ["Address", [inv.customer.address, inv.customer.city].filter(Boolean).join(", ") || "—"],
      ["Contact", [inv.customer.email, inv.customer.phone].filter(Boolean).join(" · ") || "—"],
      ["Quotation Ref", inv.quotation?.code ?? "—"],
      ["Work Order Ref", inv.workOrders.map((w) => w.code).join(", ") || "—"],
    ]);
    d.spacer(8);
  },
  items: (d, ctx) => {
    const inv = ctx.data as unknown as InvoiceRow;
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
  },
  totals: (d, ctx) => {
    const inv = ctx.data as unknown as InvoiceRow;
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
  },
  "balance-banner": (d, ctx) => {
    const inv = ctx.data as unknown as InvoiceRow;
    d.banner(
      inv.balanceCents <= 0
        ? "PAID IN FULL — Thank you."
        : `Balance due: ${money(inv.balanceCents)} — payable by ${fmtDate(inv.dueDate)}`,
      inv.balanceCents <= 0 ? "green" : "muted"
    );
  },
  payments: (d, ctx) => {
    const inv = ctx.data as unknown as InvoiceRow;
    if (inv.payments.length === 0) return;
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
  },
  "currency-banner": (d) => {
    d.banner("Currency: BND (Brunei Darussalam). All amounts in Brunei Dollars.");
  },
  notes: (d, ctx) => {
    const inv = ctx.data as unknown as InvoiceRow;
    if (inv.notes?.trim()) d.notesBlock("Notes", inv.notes);
  },
  terms: (d, ctx) => {
    const inv = ctx.data as unknown as InvoiceRow;
    if (inv.terms?.trim()) d.notesBlock("Terms", inv.terms);
  },
  qr: renderQr,
  "custom-text": renderCustomText,
};

const invoice: DocumentDef = {
  type: "invoice",
  docTitle: "Invoice",
  permission: PERMISSIONS.invoices_read,
  filenameLabel: "Invoice",
  blocks: [],
  async load(id, user, branding, origin) {
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

    const qr = await pdfQrBadge("INVOICE", id, { status: inv.status, origin, reference: inv.code });

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
      ctx: {
        data: inv,
        qr: qr ? { png: qr.png, reference: qr.reference } : null,
        vars: {
          invoice_number: inv.code,
          invoice_date: fmtDate(inv.invoiceDate),
          due_date: fmtDate(inv.dueDate),
          status: humanize(inv.status),
          customer_name: customerLabel(inv.customer),
          customer_address: [inv.customer.address, inv.customer.city].filter(Boolean).join(", ") || "—",
          customer_contact: [inv.customer.contactPerson, inv.customer.email, inv.customer.phone].filter(Boolean).join(" · ") || "—",
          quotation_ref: inv.quotation?.code ?? "—",
          work_order_refs: inv.workOrders.map((w) => w.code).join(", ") || "—",
          item_count: String(inv.items.length),
          subtotal: money(inv.subtotalCents),
          discount: money(inv.discountCents),
          shipping: money(inv.shippingCents),
          tax: money(inv.taxCents),
          total: money(inv.totalCents),
          amount_paid: money(inv.paidCents),
          balance: money(inv.balanceCents),
          company_name: branding.company,
        },
      },
    };
  },
};

// ── 6. PURCHASE ORDER ──────────────────────────────────────────────────────

type PurchaseOrderRow = {
  code: string; status: string; orderDate: Date; expectedDate: Date | null; approvedAt: Date | null;
  subtotalCents: number; taxCents: number; totalCents: number; notes: string | null;
  supplier: { code: string; name: string; contactPerson: string; email: string; phone: string; address: string };
  items: { description: string; item: { sku: string } | null; quantity: number; receivedQty: number; unitCostCents: number; totalCents: number }[];
};

const purchaseOrderRenderers: Record<string, BlockRenderer> = {
  summary: (d, ctx, opts) => {
    const po = ctx.data as unknown as PurchaseOrderRow;
    if (opts.heading?.trim()) d.heading(opts.heading.trim());
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
  },
  items: (d, ctx) => {
    const po = ctx.data as unknown as PurchaseOrderRow;
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
  },
  totals: (d, ctx) => {
    const po = ctx.data as unknown as PurchaseOrderRow;
    d.totals([
      ["Subtotal", money(po.subtotalCents)],
      ["Tax", money(po.taxCents)],
      ["Grand Total", money(po.totalCents)],
    ]);
  },
  "currency-banner": (d) => {
    d.banner("Currency: BND (Brunei Darussalam). All amounts in Brunei Dollars.");
  },
  "approval-note": (d, ctx) => {
    const po = ctx.data as unknown as PurchaseOrderRow;
    if (po.approvedAt) d.para(`Approved on ${fmtDateTime(po.approvedAt)}`, { size: 8.5, color: "muted" });
  },
  notes: (d, ctx) => {
    const po = ctx.data as unknown as PurchaseOrderRow;
    if (po.notes?.trim()) d.notesBlock("Notes", po.notes);
  },
  signatures: (d) => {
    d.signatures([{ caption: "Approved by" }, { caption: "Received by" }]);
  },
  qr: renderQr,
  "custom-text": renderCustomText,
};

const purchaseOrder: DocumentDef = {
  type: "purchase-order",
  docTitle: "Purchase Order",
  permission: PERMISSIONS.purchases_read,
  filenameLabel: "Purchase-Order",
  blocks: [],
  async load(id, user, branding, origin) {
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: { select: { code: true, name: true, contactPerson: true, email: true, phone: true, address: true } },
        items: { orderBy: { id: "asc" }, include: { item: { select: { sku: true } } } },
      },
    });
    if (!po) throw Errors.notFound("Purchase order not found.");

    const qr = await pdfQrBadge("PURCHASE_ORDER", id, { status: po.status, origin, reference: po.code });

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
      ctx: {
        data: po,
        qr: qr ? { png: qr.png, reference: qr.reference } : null,
        vars: {
          po_number: po.code,
          order_date: fmtDate(po.orderDate),
          expected_delivery: fmtDate(po.expectedDate),
          status: humanize(po.status),
          supplier_name: po.supplier.name,
          total: money(po.totalCents),
          company_name: branding.company,
        },
      },
    };
  },
};

// ── 7. EQUIPMENT REPORT ────────────────────────────────────────────────────

type EquipmentRow = {
  assetTag: string; name: string; category: string; status: string;
  manufacturer: string | null; model: string | null; serialNumber: string | null;
  installationDate: Date | null; warrantyExpiry: Date | null; pmFrequencyDays: number; notes: string | null;
  location: { name: string; code: string } | null;
  customer: { code: string; companyName: string; contactPerson: string } | null;
  pmPlans: { code: string; name: string; frequency: string; nextDueDate: Date | null; active: boolean }[];
  workOrders: { code: string; title: string; status: string; createdAt: Date }[];
  complaints: { code: string; title: string; status: string; createdAt: Date }[];
};

const equipmentReportRenderers: Record<string, BlockRenderer> = {
  summary: (d, ctx, opts) => {
    const e = ctx.data as unknown as EquipmentRow;
    if (opts.heading?.trim()) d.heading(opts.heading.trim());
    d.kvGrid([
      ["Asset Tag", e.assetTag],
      ["Name", e.name],
      ["Category", humanize(e.category)],
      ["Status", humanize(e.status)],
      ["Manufacturer", e.manufacturer || "—"],
      ["Model", e.model || "—"],
      ["Serial Number", e.serialNumber || "—"],
      ["Location", e.location ? `${e.location.name} (${e.location.code})` : "—"],
      ["Customer", e.customer ? customerLabel(e.customer) : "—"],
      ["Installed", fmtDate(e.installationDate)],
      ["Warranty Expiry", fmtDate(e.warrantyExpiry)],
      ["PM Frequency", `${e.pmFrequencyDays} days`],
    ]);
  },
  notes: (d, ctx) => {
    const e = ctx.data as unknown as EquipmentRow;
    if (e.notes?.trim()) d.notesBlock("Notes", e.notes);
  },
  "pm-plans": (d, ctx) => {
    const e = ctx.data as unknown as EquipmentRow;
    if (e.pmPlans.length === 0) return;
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
  },
  "recent-work-orders": (d, ctx) => {
    const e = ctx.data as unknown as EquipmentRow;
    if (e.workOrders.length === 0) return;
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
  },
  "recent-complaints": (d, ctx) => {
    const e = ctx.data as unknown as EquipmentRow;
    if (e.complaints.length === 0) return;
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
  },
  qr: renderQr,
  "custom-text": renderCustomText,
};

const equipmentReport: DocumentDef = {
  type: "equipment-report",
  docTitle: "Equipment Report",
  permission: PERMISSIONS.equipment_read,
  filenameLabel: "Equipment-Report",
  blocks: [],
  async load(id, user, branding, origin) {
    const e = await db.equipment.findUnique({
      where: { id },
      include: {
        location: { select: { name: true, code: true } },
        customer: { select: { code: true, companyName: true, contactPerson: true } },
        pmPlans: { select: { code: true, name: true, frequency: true, nextDueDate: true, active: true } },
        workOrders: { orderBy: { createdAt: "desc" }, take: 8, select: { code: true, title: true, status: true, createdAt: true } },
        complaints: { orderBy: { createdAt: "desc" }, take: 8, select: { code: true, title: true, status: true, createdAt: true } },
      },
    });
    if (!e) throw Errors.notFound("Equipment not found.");
    assertVisible(e.customerId, user, "Equipment");

    // The equipment report carries the SAME canonical EQUIPMENT identity as
    // the physical label (§12/§14) — one asset, one QR identity.
    const qr = await pdfQrBadge("EQUIPMENT", id, { status: e.status, origin, reference: e.assetTag });

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
      ctx: {
        data: e,
        qr: qr ? { png: qr.png, reference: qr.reference } : null,
        vars: {
          asset_tag: e.assetTag,
          name: e.name,
          category: humanize(e.category),
          status: humanize(e.status),
          manufacturer: e.manufacturer || "—",
          model: e.model || "—",
          serial_number: e.serialNumber || "—",
          location: e.location ? `${e.location.name} (${e.location.code})` : "—",
          customer_name: e.customer ? customerLabel(e.customer) : "—",
          company_name: branding.company,
        },
      },
    };
  },
};

// ── 8. PM TASK (Preventive Maintenance service sheet) ──────────────────────

type PmTaskRow = {
  code: string; status: string; dueDate: Date | null; completedAt: Date | null; notes: string | null;
  plan: { code: string; name: string; frequency: string };
  equipment: { name: string; assetTag: string; location: { name: string } | null };
  technician: { employeeNo: string; user: { name: string } } | null;
  checklist: { label: string; done: boolean }[];
};

const pmTaskRenderers: Record<string, BlockRenderer> = {
  summary: (d, ctx, opts) => {
    const t = ctx.data as unknown as PmTaskRow;
    const done = t.checklist.filter((c) => c.done).length;
    if (opts.heading?.trim()) d.heading(opts.heading.trim());
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
  },
  checklist: (d, ctx) => {
    const t = ctx.data as unknown as PmTaskRow;
    if (t.checklist.length === 0) return;
    d.heading("Service Checklist");
    d.table(
      [
        { header: "#", width: 0.4, align: "center" },
        { header: "Checklist Item", width: 4.6 },
        { header: "Result", width: 1.4, align: "center" },
      ],
      t.checklist.map((c, i) => [{ text: String(i + 1) }, c.label, c.done ? "Done" : "Pending"])
    );
  },
  notes: (d, ctx) => {
    const t = ctx.data as unknown as PmTaskRow;
    if (t.notes?.trim()) d.notesBlock("Technician Notes", t.notes);
  },
  signatures: (d, ctx) => {
    const t = ctx.data as unknown as PmTaskRow;
    d.signatures([{ caption: "Technician signature", name: t.technician?.user.name }, { caption: "Supervisor review" }]);
  },
  qr: renderQr,
  "custom-text": renderCustomText,
};

const pmTask: DocumentDef = {
  type: "pm-task",
  docTitle: "PM Service Sheet",
  permission: PERMISSIONS.pm_read,
  filenameLabel: "PM-Task",
  blocks: [],
  async load(id, user, branding, origin) {
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

    const qr = await pdfQrBadge("PM_TASK", id, { status: t.status, origin, reference: t.code });

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
      ctx: {
        data: t,
        qr: qr ? { png: qr.png, reference: qr.reference } : null,
        vars: {
          task_number: t.code,
          status: humanize(t.status),
          plan_name: `${t.plan.code} — ${t.plan.name}`,
          equipment: `${t.equipment.name} (${t.equipment.assetTag})`,
          technician: t.technician ? `${t.technician.user.name} (${t.technician.employeeNo})` : "Unassigned",
          due_date: fmtDate(t.dueDate),
          company_name: branding.company,
        },
      },
    };
  },
};

// ── 9. PAYMENT RECEIPT ─────────────────────────────────────────────────────

type PaymentRow = {
  code: string; status: string; paidAt: Date; method: string; reference: string | null; note: string | null;
  amountCents: number; customerId: string | null;
  customer: { companyName: string; contactPerson: string } | null;
  invoice: {
    code: string; customerId: string; invoiceDate: Date; totalCents: number; paidCents: number; balanceCents: number; status: string;
    customer: { companyName: string; contactPerson: string };
  } | null;
};

const paymentReceiptRenderers: Record<string, BlockRenderer> = {
  "thanks-banner": (d, ctx) => {
    const p = ctx.data as unknown as PaymentRow;
    d.banner(`Payment received with thanks — ${money(p.amountCents)}`, "green");
  },
  summary: (d, ctx, opts) => {
    const p = ctx.data as unknown as PaymentRow;
    const recorder = ctx.data.recorderName as string | null | undefined;
    const inv = p.invoice;
    if (opts.heading?.trim()) d.heading(opts.heading.trim());
    d.kvGrid([
      ["Receipt", p.code],
      ["Date", fmtDate(p.paidAt)],
      ["Payment Method", humanize(p.method)],
      ["Reference", p.reference || "—"],
      ["Received From", p.customer ? customerLabel(p.customer) : inv?.customer ? customerLabel(inv.customer) : "—"],
      ["Invoice", inv?.code ?? "—"],
      ["Invoice Status", inv ? humanize(inv.status) : "—"],
      ["Recorded By", recorder ?? "—"],
    ]);
  },
  "invoice-position": (d, ctx) => {
    const p = ctx.data as unknown as PaymentRow;
    const inv = p.invoice;
    if (!inv) return;
    d.spacer(8);
    d.heading("Invoice Position After This Payment");
    d.totals([
      ["Invoice total", money(inv.totalCents)],
      ["Total paid to date", money(inv.paidCents)],
      ["Balance remaining", money(inv.balanceCents)],
    ]);
  },
  remarks: (d, ctx) => {
    const p = ctx.data as unknown as PaymentRow;
    if (p.note?.trim()) d.notesBlock("Remarks", p.note);
  },
  "currency-banner": (d) => {
    d.banner("Currency: BND (Brunei Darussalam). All amounts in Brunei Dollars.");
  },
  signatures: (d) => {
    d.signatures([{ caption: "For MOHD.HMS Enterprise" }, { caption: "Payer acknowledgement" }]);
  },
  qr: renderQr,
  "custom-text": renderCustomText,
};

const paymentReceipt: DocumentDef = {
  type: "payment-receipt",
  docTitle: "Payment Receipt",
  permission: PERMISSIONS.payments_read,
  filenameLabel: "Payment-Receipt",
  blocks: [],
  async load(id, user, branding, origin) {
    const p = await db.payment.findUnique({
      where: { id },
      include: {
        invoice: {
          select: { code: true, customerId: true, invoiceDate: true, totalCents: true, paidCents: true, balanceCents: true, status: true, customer: { select: { companyName: true, contactPerson: true } } },
        },
        customer: { select: { companyName: true, contactPerson: true } },
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
    const qr = await pdfQrBadge("PAYMENT_RECEIPT", id, { status: p.status, origin, reference: p.code });
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
      ctx: {
        data: { ...p, recorderName: recorder?.name ?? null },
        qr: qr ? { png: qr.png, reference: qr.reference } : null,
        vars: {
          receipt_number: p.code,
          receipt_date: fmtDate(p.paidAt),
          method: humanize(p.method),
          reference: p.reference || "—",
          received_from: p.customer ? customerLabel(p.customer) : inv?.customer ? customerLabel(inv.customer) : "—",
          invoice_number: inv?.code ?? "—",
          amount: money(p.amountCents),
          company_name: branding.company,
        },
      },
    };
  },
};

// ── block assembly + registry ──────────────────────────────────────────────

export type DocumentBlockDef = BlockMeta & { render: BlockRenderer };

const RENDERERS: Record<string, Record<string, BlockRenderer>> = {
  "work-order": workOrderRenderers,
  complaint: complaintRenderers,
  "inspection-report": inspectionReportRenderers,
  quotation: quotationRenderers,
  invoice: invoiceRenderers,
  "purchase-order": purchaseOrderRenderers,
  "equipment-report": equipmentReportRenderers,
  "pm-task": pmTaskRenderers,
  "payment-receipt": paymentReceiptRenderers,
};

/** Attach the renderers to the static block metadata (BLOCK_META is the source
 *  of truth for ids/labels/required — a missing renderer is a programming
 *  error and is reported loudly instead of silently dropping a block). */
function attachBlocks(def: { type: string; renderers: Record<string, BlockRenderer> }): DocumentBlockDef[] {
  const meta = BLOCK_META[def.type as TemplateType];
  if (!meta) return [];
  const out: DocumentBlockDef[] = [];
  for (const m of meta) {
    const render = def.renderers[m.id];
    if (!render) {
      console.error(JSON.stringify({ level: "error", msg: "template.renderer_missing", docType: def.type, block: m.id }));
      continue;
    }
    out.push({ ...m, render });
  }
  return out;
}

// ── registry + dispatcher ──────────────────────────────────────────────────

export const DOCUMENT_TYPES: DocumentDef[] = [
  { ...workOrder, blocks: attachBlocks({ type: workOrder.type, renderers: workOrderRenderers }) },
  { ...complaint, blocks: attachBlocks({ type: complaint.type, renderers: complaintRenderers }) },
  { ...inspectionReport, blocks: attachBlocks({ type: inspectionReport.type, renderers: inspectionReportRenderers }) },
  { ...quotation, blocks: attachBlocks({ type: quotation.type, renderers: quotationRenderers }) },
  { ...invoice, blocks: attachBlocks({ type: invoice.type, renderers: invoiceRenderers }) },
  { ...purchaseOrder, blocks: attachBlocks({ type: purchaseOrder.type, renderers: purchaseOrderRenderers }) },
  { ...equipmentReport, blocks: attachBlocks({ type: equipmentReport.type, renderers: equipmentReportRenderers }) },
  { ...pmTask, blocks: attachBlocks({ type: pmTask.type, renderers: pmTaskRenderers }) },
  { ...paymentReceipt, blocks: attachBlocks({ type: paymentReceipt.type, renderers: paymentReceiptRenderers }) },
];

export function findDocumentType(type: string): DocumentDef | undefined {
  return DOCUMENT_TYPES.find((t) => t.type === type);
}

/**
 * THE block-plan executor (§10/§44). Walks the plan:
 *   template layout (order + hidden + headings + config)  — or the canonical
 *   built-in order when no template — executing every block through the ONE
 *   PdfDoc engine. Required blocks (QR) are forced even if a template omits
 *   them; the publish-time validator reports the same condition (§14).
 */
export async function renderBlockPlan(doc: PdfDoc, blocks: DocumentBlockDef[], ctx: BlockCtx, layout?: TemplateLayout | null): Promise<void> {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let order: string[];
  if (layout && layout.order.length > 0) {
    order = layout.order.filter((id) => byId.has(id));
    for (const b of blocks) if (b.required && !order.includes(b.id)) order.push(b.id);
  } else {
    order = blocks.map((b) => b.id);
  }
  const hidden = new Set((layout?.hidden ?? []).filter((id) => !byId.get(id)?.required));
  for (const id of order) {
    const b = byId.get(id);
    if (!b || hidden.has(id)) continue;
    await b.render(doc, ctx, { heading: layout?.headings?.[id] || undefined, config: layout?.config?.[id] ?? {} });
  }
}

/**
 * Load → resolve template (snapshot-pinned, §29/§56) → render block plan →
 * validate. Central pipeline for ALL documents — the WhatsApp/email attachment
 * builders and the PDF download route all flow through here, so every consumer
 * honours the same template + snapshot semantics.
 */
export async function buildDocument(
  def: DocumentDef,
  id: string,
  user: PdfRequestUser,
  branding?: Branding,
  origin?: string,
  opts?: { regenerate?: boolean; template?: ResolvedTemplate | null }
): Promise<BuiltDoc> {
  const { getBranding } = await import("./branding");
  const brand = branding ?? (await getBranding());
  const tpl = opts?.template !== undefined ? opts.template : await resolveTemplateForDocument(def.type, id, { regenerate: opts?.regenerate === true });
  const loaded = await def.load(id, user, brand, origin);
  // Split header fields for the §20 header toggles (harmless when the default
  // header config is used — the combined contactLines render identically).
  loaded.header.addressLines = brand.addressLines;
  loaded.header.contactLine = brand.contactLine;
  const doc = await PdfDoc.create(loaded.header, brand.logoBytes, tpl?.style);
  await renderBlockPlan(doc, def.blocks, loaded.ctx, tpl?.layout ?? null);
  const { bytes, pageCount } = await doc.build();

  // §29/§56 — pin the template version used for this generated document.
  try {
    await recordTemplateSnapshot({
      entityType: def.type,
      entityId: id,
      templateId: tpl?.templateId ?? "system",
      templateName: tpl?.templateName ?? "System Default",
      versionId: tpl?.versionId ?? "",
      versionNumber: tpl?.versionNumber ?? 0,
      generatedById: user.id,
    });
  } catch {
    // A snapshot write failure must never fail the document itself.
  }

  return {
    bytes,
    pageCount,
    filename: loaded.filename || safeFilename(`${def.filenameLabel}-${id}.pdf`),
    docTitle: def.docTitle,
    docNumber: loaded.header.docNumber,
  };
}

export type BuiltDoc = {
  bytes: Uint8Array;
  pageCount: number;
  filename: string;
  docTitle: string;
  docNumber: string;
};

/**
 * Template preview builder (§33/§34/§47) — renders a realistic SAMPLE dataset
 * through the SAME block renderers + PdfDoc engine used in production. Never
 * touches business records; the sample QR encodes an honest explanatory string
 * (no fake verification token is ever minted).
 */
export async function buildSampleDocument(type: TemplateType, layout: TemplateLayout, style: TemplateStyle, brand?: Branding): Promise<BuiltDoc> {
  const def = findDocumentType(type);
  if (!def) throw Errors.notFound(`Unknown document type "${type}".`);
  const { getBranding } = await import("./branding");
  const b = brand ?? (await getBranding());
  const ctx = await sampleContext(type, b);
  const doc = await PdfDoc.create(ctx.header, b.logoBytes, style);
  await renderBlockPlan(doc, def.blocks, ctx, layout);
  const { bytes, pageCount } = await doc.build();
  return {
    bytes,
    pageCount,
    filename: safeFilename(`MOHD-HMS-${def.filenameLabel}-Template-Preview.pdf`),
    docTitle: def.docTitle,
    docNumber: ctx.header.docNumber,
  };
}
