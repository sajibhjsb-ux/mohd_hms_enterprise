// MOHD.HMS ENTERPRISE — Checklist context builder (AI checklist spec §5/§79).
// Collects ONLY the structured, relevant work context for AI generation:
// work type, equipment facts, category, location, complaint/scope text, PM plan,
// maintenance history. Data minimization is enforced here — no customer contact
// details, no employee PII, no finance data, no credentials ever leave this file
// into the prompt.

import "server-only";
import { db } from "@/lib/db";
import { parseChecklistItems, type ChecklistItemSpec } from "./types";

export type ChecklistContext = {
  sourceType: string;
  sourceId: string;
  title: string;
  description: string;
  workType: string;
  category: string;
  equipment: null | {
    name: string;
    assetTag: string;
    category: string;
    manufacturer: string;
    model: string;
    serialNumber: string;
    criticality: string;
    location: string;
  };
  location: string;
  customerName: string;
  pmPlan: null | { code: string; name: string; frequency: string; safetyRequirements: string };
  previousFindings: { title: string; severity: string; recommendation: string }[];
  lastServiceResults: { label: string; response: string }[];
  recentComplaints: { code: string; title: string }[];
  approvedTemplate: { name: string; version: number; items: ChecklistItemSpec[] } | null;
  missing: string[];
};

const CATEGORY_KEYWORDS: [RegExp, string][] = [
  [/\b(ac|a\/c|air ?con|air ?condition|chiller|fcu|ahu|cooling|compressor|refrigerant|split ac|vrv|vrf)\b/i, "HVAC"],
  [/generator|genset|alternator/i, "GENERATOR"],
  [/\b(lift|elevator|escalator)\b/i, "LIFT"],
  [/fire (alarm|sprinkler|extinguisher|pump|suppression)|fire protection/i, "FIRE_PROTECTION"],
  [/\b(pipe|piping|plumb|leak|tap|faucet|sanitary|drain|sewage|water pump)\b/i, "PLUMBING"],
  [/\b(light|lighting|power|socket|wiring|electrical|mcb|mccb|db\b|panel|cable|contactor|electric)\b/i, "ELECTRICAL"],
  [/\b(pest|termite|rodent|cockroach)\b/i, "PEST_CONTROL"],
  [/\b(clean|cleaning|housekeeping)\b/i, "CLEANING"],
  [/\b(garden|grass|landscape|lawn|tree)\b/i, "LANDSCAPE"],
  [/\b(pump|motor|bearing|gear|belt|valve|conveyor)\b/i, "MECHANICAL"],
  [/\b(wall|ceiling|floor|roof|door|window|paint|concrete|civil)\b/i, "BUILDING"],
];

function inferCategory(...texts: string[]): string {
  const joined = texts.filter(Boolean).join(" \n ");
  for (const [re, cat] of CATEGORY_KEYWORDS) {
    if (re.test(joined)) return cat;
  }
  return "GENERAL";
}

function inferWorkType(sourceType: string, title: string, description: string): string {
  const text = `${title} ${description}`;
  if (sourceType === "PM") return "PREVENTIVE";
  if (sourceType === "IRMS") return "INSPECTION";
  if (/commission/i.test(text)) return "COMMISSIONING";
  if (/install/i.test(text)) return "INSTALLATION";
  if (/inspect|survey|audit/i.test(text)) return "INSPECTION";
  if (/preventive|servicing|service call/i.test(text)) return "PREVENTIVE";
  if (sourceType === "COMPLAINT") return "TROUBLESHOOTING";
  return "CORRECTIVE";
}

async function equipmentHistory(equipmentId: string | null) {
  if (!equipmentId) return { findings: [], lastResults: [], complaints: [] };
  const [findings, lastWo, complaints] = await Promise.all([
    db.pmFinding.findMany({
      where: { equipmentId },
      orderBy: { createdAt: "desc" },
      take: 4,
      select: { title: true, severity: true, recommendation: true },
    }),
    db.workOrder.findFirst({
      where: { equipmentId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      select: { code: true, checklist: { select: { label: true, response: true, done: true }, orderBy: { sortOrder: "asc" }, take: 20 } },
    }),
    db.complaint.findMany({
      where: { equipmentId },
      orderBy: { createdAt: "desc" },
      take: 4,
      select: { code: true, title: true },
    }),
  ]);
  return {
    findings,
    lastResults: (lastWo?.checklist ?? []).map((c) => ({ label: c.label, response: c.done ? c.response || "done" : "pending" })),
    complaints,
  };
}

/**
 * Build the generation context for any supported source. Never throws —
 * `missing` reports absent context so the prompt stays honest (spec §6:
 * "Required technical reference not available").
 */
export async function buildChecklistContext(
  sourceType: "COMPLAINT" | "WORK_ORDER" | "PM" | "IRMS",
  sourceId: string,
  approvedTemplate?: { name: string; version: number; items: ChecklistItemSpec[] } | null
): Promise<ChecklistContext> {
  const ctx: ChecklistContext = {
    sourceType,
    sourceId,
    title: "",
    description: "",
    workType: "GENERAL",
    category: "GENERAL",
    equipment: null,
    location: "",
    customerName: "",
    pmPlan: null,
    previousFindings: [],
    lastServiceResults: [],
    recentComplaints: [],
    approvedTemplate: approvedTemplate ?? null,
    missing: [],
  };

  if (sourceType === "COMPLAINT") {
    const complaint = await db.complaint.findUnique({
      where: { id: sourceId },
      select: {
        title: true, description: true,
        customer: { select: { companyName: true } },
        equipment: {
          select: {
            id: true, name: true, assetTag: true, category: true, manufacturer: true, model: true,
            serialNumber: true, criticality: true, location: { select: { name: true } },
          },
        },
      },
    });
    if (!complaint) { ctx.missing.push("Complaint record not found"); return ctx; }
    ctx.title = complaint.title;
    ctx.description = complaint.description;
    ctx.customerName = complaint.customer.companyName;
    ctx.workType = inferWorkType("COMPLAINT", complaint.title, complaint.description);
    if (complaint.equipment) {
      const eq = complaint.equipment;
      ctx.equipment = {
        name: eq.name, assetTag: eq.assetTag, category: eq.category, manufacturer: eq.manufacturer,
        model: eq.model, serialNumber: eq.serialNumber, criticality: eq.criticality,
        location: eq.location?.name ?? "",
      };
      ctx.location = eq.location?.name ?? "";
      ctx.category = eq.category && eq.category !== "GENERAL" ? eq.category : inferCategory(complaint.title, complaint.description);
      const hist = await equipmentHistory(eq.id);
      ctx.previousFindings = hist.findings;
      ctx.lastServiceResults = hist.lastResults;
      ctx.recentComplaints = hist.complaints;
    } else {
      ctx.category = inferCategory(complaint.title, complaint.description);
      ctx.missing.push("No equipment linked to this complaint");
    }
  } else if (sourceType === "WORK_ORDER" || sourceType === "PM") {
    const wo = await db.workOrder.findUnique({
      where: { id: sourceId },
      select: {
        title: true, description: true, sourceType: true,
        complaint: { select: { title: true, description: true } },
        customer: { select: { companyName: true } },
        equipment: {
          select: {
            id: true, name: true, assetTag: true, category: true, manufacturer: true, model: true,
            serialNumber: true, criticality: true, location: { select: { name: true } },
          },
        },
        pmTask: { select: { plan: { select: { code: true, name: true, frequency: true, safetyRequirements: true } } } },
      },
    });
    if (!wo) { ctx.missing.push("Work order not found"); return ctx; }
    ctx.title = wo.complaint ? `${wo.complaint.title} — ${wo.title}` : wo.title;
    ctx.description = [wo.description, wo.complaint?.description].filter(Boolean).join("\n");
    ctx.customerName = wo.customer.companyName;
    ctx.workType = inferWorkType(wo.sourceType === "PM" ? "PM" : "WORK_ORDER", ctx.title, ctx.description);
    if (wo.pmTask?.plan) {
      ctx.pmPlan = {
        code: wo.pmTask.plan.code,
        name: wo.pmTask.plan.name,
        frequency: wo.pmTask.plan.frequency,
        safetyRequirements: wo.pmTask.plan.safetyRequirements,
      };
      ctx.workType = "PREVENTIVE";
    }
    if (wo.equipment) {
      const eq = wo.equipment;
      ctx.equipment = {
        name: eq.name, assetTag: eq.assetTag, category: eq.category, manufacturer: eq.manufacturer,
        model: eq.model, serialNumber: eq.serialNumber, criticality: eq.criticality,
        location: eq.location?.name ?? "",
      };
      ctx.location = eq.location?.name ?? "";
      ctx.category = eq.category && eq.category !== "GENERAL" ? eq.category : inferCategory(ctx.title, ctx.description);
      const hist = await equipmentHistory(eq.id);
      ctx.previousFindings = hist.findings;
      ctx.lastServiceResults = hist.lastResults;
      ctx.recentComplaints = hist.complaints;
    } else {
      ctx.category = inferCategory(ctx.title, ctx.description);
      ctx.missing.push("No equipment linked to this work order");
    }
  } else if (sourceType === "IRMS") {
    const report = await db.inspectionReport.findUnique({
      where: { id: sourceId },
      select: {
        title: true, type: true, scope: true, taskDescription: true,
        project: { select: { name: true, customer: { select: { companyName: true } } } },
        equipment: {
          select: {
            id: true, name: true, assetTag: true, category: true, manufacturer: true, model: true,
            serialNumber: true, criticality: true, location: { select: { name: true } },
          },
        },
      },
    });
    if (!report) { ctx.missing.push("Inspection report not found"); return ctx; }
    ctx.title = report.title;
    ctx.description = [report.taskDescription, report.scope].filter(Boolean).join("\n");
    ctx.customerName = report.project?.customer?.companyName ?? "";
    ctx.location = report.project?.name ?? "";
    ctx.workType = "INSPECTION";
    if (report.equipment) {
      const eq = report.equipment;
      ctx.equipment = {
        name: eq.name, assetTag: eq.assetTag, category: eq.category, manufacturer: eq.manufacturer,
        model: eq.model, serialNumber: eq.serialNumber, criticality: eq.criticality,
        location: eq.location?.name ?? "",
      };
      ctx.category = eq.category && eq.category !== "GENERAL" ? eq.category : inferCategory(ctx.title, ctx.description);
      const hist = await equipmentHistory(eq.id);
      ctx.previousFindings = hist.findings;
      ctx.lastServiceResults = hist.lastResults;
    } else {
      ctx.category = inferCategory(ctx.title, ctx.description);
      ctx.missing.push("No equipment linked to this inspection");
    }
  }

  return ctx;
}

/** Minimal, non-sensitive context fingerprint for the AI generation log (§38/§80). */
export function contextFingerprint(ctx: ChecklistContext): string {
  return JSON.stringify({
    sourceType: ctx.sourceType,
    workType: ctx.workType,
    category: ctx.category,
    equipment: ctx.equipment ? `${ctx.equipment.name} (${ctx.equipment.assetTag})` : null,
    hasTemplate: !!ctx.approvedTemplate,
    missing: ctx.missing,
  });
}
