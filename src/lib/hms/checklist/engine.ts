// MOHD.HMS ENTERPRISE — Centralized checklist ENGINE (AI checklist spec §82).
// ONE engine for Complaints / Work Orders / PM / IRMS:
//   context → approved template → AI draft → structured validation →
//   human approval (when required) → versioned instance → materialized
//   WorkOrderChecklistItem snapshot → execution → completion validation.
// The engine NEVER calls emit() itself (that would import the workflow bus into
// the engine — routes/handlers own the event emission); it does own its audits.

import "server-only";
import { db } from "@/lib/db";
import { ApiError, Errors } from "@/lib/hms/api";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { isAutomationEnabled, automationNumber } from "@/lib/hms/workflows/settings";
import { buildChecklistContext, contextFingerprint, type ChecklistContext } from "./context";
import { CHECKLIST_PROMPT_VERSION, buildChecklistPrompt, buildSummaryPrompt } from "./prompt";
import { callChecklistAi, callChecklistSummaryAi } from "./ai";
import { validateAiChecklist, validateManualItem } from "./validate";
import { parseChecklistItems, type ChecklistItemSpec, type ChecklistOrigin, type ChecklistSourceType } from "./types";

// ── Template library ─────────────────────────────────────────────────────────

/** Find the best approved template for a context: category+workType first, then category, then workType. */
export async function findBestTemplate(ctx: { category: string; workType: string }): Promise<{ id: string; name: string; version: number; items: ChecklistItemSpec[]; approvalRequired: boolean } | null> {
  const templates = await db.checklistTemplate.findMany({
    where: { status: "ACTIVE" },
    orderBy: [{ category: "asc" }, { workType: "asc" }],
    take: 200,
    select: { id: true, name: true, version: true, items: true, category: true, workType: true, equipmentCategory: true, approvalRequired: true },
  });
  if (templates.length === 0) return null;
  const parse = (t: (typeof templates)[number]) => ({ id: t.id, name: t.name, version: t.version, items: parseChecklistItems(t.items), approvalRequired: t.approvalRequired });
  const exact = templates.find((t) => t.category === ctx.category && t.workType === ctx.workType);
  if (exact) return parse(exact);
  const catOnly = templates.find((t) => t.category === ctx.category);
  if (catOnly) return parse(catOnly);
  const typeOnly = templates.find((t) => t.workType === ctx.workType);
  if (typeOnly) return parse(typeOnly);
  const general = templates.find((t) => t.category === "GENERAL" && t.workType === "GENERAL");
  return general ? parse(general) : null;
}

async function loadTemplateById(templateId: string) {
  const t = await db.checklistTemplate.findUnique({ where: { id: templateId } });
  if (!t || t.status !== "ACTIVE") return null;
  return { id: t.id, name: t.name, version: t.version, items: parseChecklistItems(t.items), approvalRequired: t.approvalRequired };
}

// ── Source resolution + guards ───────────────────────────────────────────────

type ResolvedSource = {
  customerId: string | null;
  equipmentId: string | null;
  workOrderId: string | null;
  title: string;
  closed: boolean;
};

async function resolveSource(sourceType: ChecklistSourceType, sourceId: string): Promise<ResolvedSource> {
  if (sourceType === "COMPLAINT") {
    const c = await db.complaint.findUnique({ where: { id: sourceId }, select: { title: true, status: true, customerId: true, equipmentId: true, workOrders: { select: { id: true } } } });
    if (!c) throw Errors.notFound("Complaint not found.");
    return { customerId: c.customerId, equipmentId: c.equipmentId, workOrderId: c.workOrders[0]?.id ?? null, title: c.title, closed: ["CANCELLED", "CLOSED"].includes(c.status) };
  }
  if (sourceType === "WORK_ORDER" || sourceType === "PM") {
    const wo = await db.workOrder.findUnique({ where: { id: sourceId }, select: { id: true, title: true, status: true, customerId: true, equipmentId: true, complaintId: true } });
    if (!wo) throw Errors.notFound("Work order not found.");
    return { customerId: wo.customerId, equipmentId: wo.equipmentId, workOrderId: wo.id, title: wo.title, closed: ["COMPLETED", "CANCELLED"].includes(wo.status) };
  }
  // IRMS
  const report = await db.inspectionReport.findUnique({ where: { id: sourceId }, select: { title: true, status: true, workOrderId: true, equipmentId: true, project: { select: { customerId: true } } } });
  if (!report) throw Errors.notFound("Inspection report not found.");
  return {
    customerId: report.project.customerId,
    equipmentId: report.equipmentId,
    workOrderId: report.workOrderId,
    title: report.title,
    closed: ["ARCHIVED", "REJECTED"].includes(report.status),
  };
}

async function findInstanceForSource(sourceType: ChecklistSourceType, sourceId: string) {
  return db.checklistInstance.findFirst({
    where: { sourceType, sourceId },
    orderBy: { createdAt: "desc" },
  });
}

// ── Materialization (§28 snapshot into the ONE execution surface) ────────────

/**
 * Write the instance's versioned draft items into WorkOrderChecklistItem rows.
 * Must run inside the caller's transaction. Guards: target WO must exist, be
 * open and have NO checklist items yet — an active work order keeps its own
 * snapshot and is never silently replaced (§27/§57).
 */
export async function materializeInstance(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], instanceId: string, workOrderId: string) {
  const instance = await tx.checklistInstance.findUnique({ where: { id: instanceId } });
  if (!instance) throw Errors.notFound("Checklist instance not found.");
  const wo = await tx.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, status: true, code: true } });
  if (!wo) throw Errors.notFound("Work order not found.");
  if (["COMPLETED", "CANCELLED"].includes(wo.status)) {
    throw Errors.invalidTransition(`Checklists cannot be attached to a ${wo.status.toLowerCase()} work order.`);
  }
  const existing = await tx.workOrderChecklistItem.count({ where: { workOrderId: wo.id } });
  if (existing > 0) {
    throw Errors.conflict(`Work order ${wo.code} already has ${existing} checklist item(s). Attach is blocked to protect the existing checklist snapshot.`);
  }
  const items = parseChecklistItems(instance.itemsJson);
  if (items.length === 0) throw Errors.badRequest("This checklist draft has no items to attach.");
  await tx.workOrderChecklistItem.createMany({
    data: items.map((it, i) => ({
      workOrderId: wo.id,
      label: it.label,
      required: it.required,
      responseType: it.responseType,
      sortOrder: i,
      origin: it.origin ?? (instance.origin === "HYBRID" ? "MANUAL" : (instance.origin as string)),
      priority: it.priority ?? "ROUTINE",
      safetyCritical: !!it.safetyCritical,
      expectedResult: it.expectedResult ?? "",
      unit: it.unit ?? "",
      requiresPhoto: !!it.requiresPhoto,
      failRequiresFinding: !!it.failRequiresFinding,
    })),
  });
  const updated = await tx.checklistInstance.update({
    where: { id: instance.id },
    data: { workOrderId: wo.id, status: "ACTIVE" },
  });
  return updated;
}

// ── Draft generation (AI ASSIST / TEMPLATE / AUTO) ───────────────────────────

export type GenerateResult = {
  instanceId: string;
  code: string;
  status: string;
  origin: ChecklistOrigin;
  itemCount: number;
  /** §72 fallback notice when AI was unavailable and an approved template was used. */
  notice?: string;
  dropped: string[];
};

async function persistDraft(opts: {
  existingInstanceId: string | null;
  sourceType: ChecklistSourceType;
  sourceId: string;
  title: string;
  items: ChecklistItemSpec[];
  origin: ChecklistOrigin;
  requireApproval: boolean;
  templateId: string | null;
  templateVersion: number | null;
  aiGenerationId: string | null;
  customerId: string | null;
  equipmentId: string | null;
  workOrderId: string | null;
  createdById: string | null;
  versionNote: string;
}): Promise<{ id: string; code: string; status: string }> {
  const { existingInstanceId } = opts;
  const status = opts.requireApproval ? "PENDING_APPROVAL" : opts.workOrderId ? "ACTIVE" : "APPROVED";
  return db.$transaction(async (tx) => {
    let instance;
    if (existingInstanceId) {
      const prev = await tx.checklistInstance.findUnique({ where: { id: existingInstanceId } });
      if (!prev) throw Errors.notFound("Checklist instance not found.");
      // §27 — preserve the old version before replacing it.
      await tx.checklistInstanceVersion.create({
        data: { instanceId: prev.id, version: prev.version, origin: prev.origin, itemsJson: prev.itemsJson, note: opts.versionNote, createdById: opts.createdById },
      });
      instance = await tx.checklistInstance.update({
        where: { id: prev.id },
        data: {
          title: opts.title, itemsJson: JSON.stringify(opts.items), origin: opts.origin,
          status, version: prev.version + 1, templateId: opts.templateId, templateVersion: opts.templateVersion,
          aiGenerationId: opts.aiGenerationId, approvalRequired: opts.requireApproval,
          rejectedReason: "", updatedAt: new Date(),
        },
      });
    } else {
      const code = await nextChecklistCode(tx);
      instance = await tx.checklistInstance.create({
        data: {
          code, title: opts.title, sourceType: opts.sourceType, sourceId: opts.sourceId,
          workOrderId: opts.workOrderId, customerId: opts.customerId, equipmentId: opts.equipmentId,
          origin: opts.origin, status, itemsJson: JSON.stringify(opts.items),
          templateId: opts.templateId, templateVersion: opts.templateVersion,
          aiGenerationId: opts.aiGenerationId, approvalRequired: opts.requireApproval,
          createdById: opts.createdById,
        },
      });
    }
    // §68 — activation + materialization in ONE transaction.
    if (status === "ACTIVE" && opts.workOrderId) {
      await materializeInstance(tx, instance.id, opts.workOrderId);
    }
    return { id: instance.id, code: instance.code, status: instance.status };
  });
}

async function nextChecklistCode(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]): Promise<string> {
  const year = new Date().getFullYear();
  const key = `CHKL-${year}`;
  const counter = await tx.counter.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1 },
  });
  return `CHKL-${year}-${String(counter.value).padStart(4, "0")}`;
}

/**
 * Generate (or regenerate) a checklist draft for a source.
 *  - mode "TEMPLATE": use the selected/approved template only (deterministic, §15 template-first).
 *  - mode "AI_ASSIST": real AI provider call (§71) with template preference in context (§16).
 *  - mode "AUTO": workflow-triggered — template first; AI only when explicitly enabled (§23).
 * AI failure → approved-template fallback (§72); nothing → friendly 503 (§73).
 */
export async function generateChecklistDraft(opts: {
  actorId: string | null;
  actorEmail: string;
  sourceType: ChecklistSourceType;
  sourceId: string;
  mode: "AI_ASSIST" | "TEMPLATE" | "AUTO";
  templateId?: string;
}): Promise<GenerateResult> {
  const source = await resolveSource(opts.sourceType, opts.sourceId);
  if (source.closed) throw Errors.invalidTransition("This record is closed — checklists can no longer be generated for it.");

  const existing = await findInstanceForSource(opts.sourceType, opts.sourceId);
  if (existing && ["ACTIVE", "COMPLETED", "APPROVED"].includes(existing.status)) {
    throw Errors.conflict(
      existing.workOrderId
        ? "This record already has an active checklist. Regeneration would alter live work — only drafts awaiting review can be regenerated."
        : "An approved checklist already exists for this record and will be attached to its work order."
    );
  }

  const ctx = await buildChecklistContext(opts.sourceType, opts.sourceId);
  let template = opts.templateId ? await loadTemplateById(opts.templateId) : await findBestTemplate({ category: ctx.category, workType: ctx.workType });
  if (opts.mode === "TEMPLATE" && !template) {
    throw Errors.badRequest("Selected checklist template is not available.");
  }

  const maxTasks = await automationNumber("checklist_max_tasks", 50);

  // ── TEMPLATE mode: deterministic, no AI. §24: approved templates may activate
  // automatically unless the template itself demands approval.
  if (opts.mode === "TEMPLATE") {
    const result = await persistDraft({
      existingInstanceId: existing?.id ?? null,
      sourceType: opts.sourceType, sourceId: opts.sourceId,
      title: template!.name,
      items: template!.items.map((it) => ({ ...it, origin: "TEMPLATE" as const })),
      origin: "TEMPLATE",
      requireApproval: template!.approvalRequired,
      templateId: template!.id, templateVersion: template!.version,
      aiGenerationId: null,
      customerId: source.customerId, equipmentId: source.equipmentId, workOrderId: source.workOrderId,
      createdById: opts.actorId,
      versionNote: `Replaced by template ${template!.name} v${template!.version}`,
    });
    await audit({
      actorId: opts.actorId, actorEmail: opts.actorEmail, action: "CHECKLIST_GENERATED",
      resourceType: "CHECKLIST_INSTANCE", resourceId: result.id,
      metadata: { code: result.code, origin: "TEMPLATE", templateId: template!.id, templateVersion: template!.version, itemCount: template!.items.length, sourceType: opts.sourceType },
    });
    return { instanceId: result.id, code: result.code, status: result.status, origin: "TEMPLATE", itemCount: template!.items.length, dropped: [] };
  }

  // ── AI paths (AI_ASSIST / AUTO). §23/§58: auto generation must be explicitly enabled.
  const aiEnabled = await isAutomationEnabled("checklist_ai_enabled");
  if (!aiEnabled) {
    if (template) return generateChecklistDraft({ ...opts, mode: "TEMPLATE", templateId: template.id });
    throw new ApiError(503, "AI_UNAVAILABLE", "AI generation is disabled. No approved checklist template matches this work — build the checklist manually instead.");
  }

  const gen = await db.checklistAiGeneration.create({
    data: {
      sourceType: opts.sourceType, sourceId: opts.sourceId, workOrderId: source.workOrderId,
      templateId: template?.id ?? null, templateVersion: template?.version ?? null,
      promptVersion: CHECKLIST_PROMPT_VERSION, provider: "unknown", model: "",
      status: "PENDING", contextSummary: "",
      createdById: opts.actorId,
    },
  });

  const { system, user } = buildChecklistPrompt(ctx, maxTasks);
  const ai = await callChecklistAi(system, user);

  if (ai.ok) {
    const validation = validateAiChecklist(ai.raw, { maxTasks });
    if (validation.ok) {
      await db.checklistAiGeneration.update({
        where: { id: gen.id },
        data: { status: "COMPLETED", provider: ai.provider, model: ai.model, itemCount: validation.items.length, contextSummary: contextFingerprint(ctx) },
      });
      const requireApproval = await isAutomationEnabled("checklist_require_approval");
      const result = await persistDraft({
        existingInstanceId: existing?.id ?? null,
        sourceType: opts.sourceType, sourceId: opts.sourceId,
        title: validation.title,
        items: validation.items,
        origin: "AI",
        requireApproval,
        templateId: template?.id ?? null, templateVersion: template?.version ?? null,
        aiGenerationId: gen.id,
        customerId: source.customerId, equipmentId: source.equipmentId, workOrderId: source.workOrderId,
        createdById: opts.actorId,
        versionNote: "Regenerated by AI (previous draft preserved)",
      });
      await audit({
        actorId: opts.actorId, actorEmail: opts.actorEmail, action: "CHECKLIST_GENERATED",
        resourceType: "CHECKLIST_INSTANCE", resourceId: result.id,
        metadata: { code: result.code, origin: "AI", promptVersion: CHECKLIST_PROMPT_VERSION, itemCount: validation.items.length, dropped: validation.dropped.length, sourceType: opts.sourceType },
      });
      if (validation.dropped.length > 0) {
        await audit({
          actorId: opts.actorId, actorEmail: opts.actorEmail, action: "CHECKLIST_VALIDATION_DROPPED",
          resourceType: "CHECKLIST_INSTANCE", resourceId: result.id,
          metadata: { dropped: validation.dropped.slice(0, 10) },
        });
      }
      return { instanceId: result.id, code: result.code, status: result.status, origin: "AI", itemCount: validation.items.length, dropped: validation.dropped };
    }
    // §41 — invalid AI output is never saved.
    await db.checklistAiGeneration.update({
      where: { id: gen.id },
      data: { status: "VALIDATION_FAILED", provider: ai.provider, model: ai.model, error: validation.reason, contextSummary: contextFingerprint(ctx) },
    });
  } else {
    await db.checklistAiGeneration.update({
      where: { id: gen.id },
      data: { status: "FAILED", error: ai.error, contextSummary: contextFingerprint(ctx) },
    });
  }

  // §72 — deterministic fallback: an approved template keeps the operation moving.
  if (template) {
    const viaTemplate = await generateChecklistDraft({ ...opts, mode: "TEMPLATE", templateId: template.id });
    await db.checklistAiGeneration.update({ where: { id: gen.id }, data: { status: "FALLBACK_TEMPLATE", instanceId: viaTemplate.instanceId } });
    return { ...viaTemplate, notice: "AI generation is temporarily unavailable. An approved checklist template was used instead — you can regenerate with AI later." };
  }
  // §73 — manual fallback.
  throw new ApiError(503, "AI_UNAVAILABLE", "AI generation is temporarily unavailable and no approved template matches this work. You can retry, or build the checklist manually.");
}

// ── Review workflow (§24/§25/§54) ────────────────────────────────────────────

async function loadInstance(instanceId: string) {
  const instance = await db.checklistInstance.findUnique({
    where: { id: instanceId },
    include: { workOrder: { select: { id: true, code: true, status: true, technician: { select: { userId: true, user: { select: { name: true } } } } } } },
  });
  if (!instance) throw Errors.notFound("Checklist not found.");
  return instance;
}

/** Approve a draft. If it belongs to a work order → materialize the snapshot in one transaction (§68). */
export async function approveChecklist(opts: { actorId: string; actorEmail: string; instanceId: string }): Promise<{ id: string; code: string; status: string }> {
  const instance = await loadInstance(opts.instanceId);
  if (!["DRAFT", "PENDING_APPROVAL"].includes(instance.status)) {
    throw Errors.invalidTransition(`A ${instance.status.toLowerCase()} checklist cannot be approved. Only drafts awaiting review can.`);
  }
  const approved = await db.$transaction(async (tx) => {
    const updated = await tx.checklistInstance.update({
      where: { id: instance.id },
      data: { status: "APPROVED", approvedById: opts.actorId, approvedAt: new Date() },
    });
    if (instance.workOrderId) {
      await materializeInstance(tx, instance.id, instance.workOrderId);
    }
    return updated;
  });
  const finalRow = await db.checklistInstance.findUnique({ where: { id: instance.id }, select: { status: true } });
  await audit({
    actorId: opts.actorId, actorEmail: opts.actorEmail, action: "CHECKLIST_APPROVED",
    resourceType: "CHECKLIST_INSTANCE", resourceId: instance.id,
    metadata: { code: instance.code, version: instance.version, itemCount: parseChecklistItems(instance.itemsJson).length },
  });
  if (finalRow?.status === "ACTIVE") {
    await audit({
      actorId: opts.actorId, actorEmail: opts.actorEmail, action: "CHECKLIST_ACTIVATED",
      resourceType: "CHECKLIST_INSTANCE", resourceId: instance.id,
      metadata: { code: instance.code, workOrderCode: instance.workOrder?.code ?? null },
    });
  }
  if (instance.workOrder?.technician?.userId) {
    await notify({
      userId: instance.workOrder.technician.userId,
      title: "Checklist assigned",
      message: `Checklist ${instance.code} (${instance.title}) is approved and ready on work order ${instance.workOrder.code}.`,
      type: "INFO", resourceType: "WORK_ORDER", resourceId: instance.workOrderId ?? undefined,
    });
  }
  return { id: approved.id, code: approved.code, status: finalRow?.status ?? approved.status };
}

export async function rejectChecklist(opts: { actorId: string; actorEmail: string; instanceId: string; reason: string }): Promise<{ id: string; code: string }> {
  const instance = await loadInstance(opts.instanceId);
  if (!["DRAFT", "PENDING_APPROVAL"].includes(instance.status)) {
    throw Errors.invalidTransition("Only drafts awaiting review can be rejected.");
  }
  const updated = await db.checklistInstance.update({
    where: { id: instance.id },
    data: { status: "REJECTED", rejectedReason: opts.reason.slice(0, 2000) },
  });
  await audit({
    actorId: opts.actorId, actorEmail: opts.actorEmail, action: "CHECKLIST_REJECTED",
    resourceType: "CHECKLIST_INSTANCE", resourceId: instance.id,
    metadata: { code: instance.code, reason: opts.reason.slice(0, 300) },
  });
  return { id: updated.id, code: updated.code };
}

/** Attach an approved (or approval-exempt) checklist to a work order (review page action). */
export async function attachChecklistToWorkOrder(opts: { actorId: string; actorEmail: string; instanceId: string; workOrderId: string }) {
  const instance = await loadInstance(opts.instanceId);
  if (instance.status === "ACTIVE" && instance.workOrderId === opts.workOrderId) {
    return { alreadyAttached: true };
  }
  if (!["APPROVED", "PENDING_APPROVAL", "DRAFT"].includes(instance.status)) {
    throw Errors.invalidTransition(`A ${instance.status.toLowerCase()} checklist cannot be attached to a work order.`);
  }
  if (instance.status !== "APPROVED") {
    throw Errors.invalidTransition("Approve the checklist before attaching it to a work order.");
  }
  const result = await db.$transaction(async (tx) => {
    return materializeInstance(tx, instance.id, opts.workOrderId);
  });
  await audit({
    actorId: opts.actorId, actorEmail: opts.actorEmail, action: "CHECKLIST_ACTIVATED",
    resourceType: "CHECKLIST_INSTANCE", resourceId: instance.id,
    metadata: { code: instance.code, workOrderId: opts.workOrderId, version: instance.version },
  });
  return { alreadyAttached: false, status: result.status };
}

// ── AI summary from REAL results (§30/§63) ───────────────────────────────────

export async function summarizeChecklistResults(opts: { actorId: string; actorEmail: string; instanceId: string }): Promise<string> {
  const instance = await loadInstance(opts.instanceId);
  if (!instance.workOrderId) throw Errors.badRequest("AI summary is available once the checklist is attached to a work order.");
  const items = await db.workOrderChecklistItem.findMany({
    where: { workOrderId: instance.workOrderId },
    orderBy: { sortOrder: "asc" },
    select: { label: true, responseType: true, response: true, done: true, notes: true, required: true },
  });
  if (items.length === 0) throw Errors.badRequest("No checklist results recorded yet.");
  const { system, user } = buildSummaryPrompt({ title: instance.title, code: instance.code, results: items });
  const summary = await callChecklistSummaryAi(system, user);
  if (!summary) throw new ApiError(503, "AI_UNAVAILABLE", "AI summary is temporarily unavailable. The recorded results remain available below.");
  await db.checklistInstance.update({
    where: { id: instance.id },
    data: { aiSummary: summary, aiSummaryAt: new Date() },
  });
  await audit({
    actorId: opts.actorId, actorEmail: opts.actorEmail, action: "CHECKLIST_AI_SUMMARY",
    resourceType: "CHECKLIST_INSTANCE", resourceId: instance.id,
    metadata: { code: instance.code, promptVersion: "checklist-summary-v1" },
  });
  return summary;
}

// ── Workflow-handler bridges (§23/§36/§69) ───────────────────────────────────

/**
 * Auto-attach a complaint's APPROVED checklist to a newly created work order.
 * Returns what happened so the workflow handler can log a precise detail.
 */
export async function autoAttachForComplaint(complaintId: string): Promise<string> {
  const complaint = await db.complaint.findUnique({
    where: { id: complaintId },
    select: { workOrders: { select: { id: true, status: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!complaint || complaint.workOrders.length === 0) return "no work order for complaint yet";
  const instance = await findInstanceForSource("COMPLAINT", complaintId);
  if (!instance || instance.status !== "APPROVED" || instance.workOrderId) return `complaint checklist status=${instance?.status ?? "none"} — not attaching`;
  const target = complaint.workOrders.find((w) => !["COMPLETED", "CANCELLED"].includes(w.status));
  if (!target) return "no open work order";
  const items = await db.workOrderChecklistItem.count({ where: { workOrderId: target.id } });
  if (items > 0) return "work order already has checklist items";
  try {
    await db.$transaction(async (tx) => materializeInstance(tx, instance.id, target.id));
    await audit({
      actorEmail: "SYSTEM", action: "CHECKLIST_ACTIVATED",
      resourceType: "CHECKLIST_INSTANCE", resourceId: instance.id,
      metadata: { code: instance.code, workOrderId: target.id, auto: true },
    });
    return `attached ${instance.code} to work order`;
  } catch {
    return "attach failed (work order state changed)";
  }
}

/**
 * AUTO mode for a newly created work order (template-first only — no AI content
 * is auto-generated for WOs; §23 "Offer Generate AI Checklist" is the AI ASSIST button).
 */
export async function autoGenerateForWorkOrder(workOrderId: string, actorEmail = "SYSTEM"): Promise<string> {
  const wo = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, status: true } });
  if (!wo || ["COMPLETED", "CANCELLED"].includes(wo.status)) return "work order not open";
  const itemCount = await db.workOrderChecklistItem.count({ where: { workOrderId: wo.id } });
  if (itemCount > 0) return "work order already has checklist items";
  const existing = await db.checklistInstance.findFirst({ where: { workOrderId: wo.id }, select: { id: true, status: true } });
  if (existing) return `instance already ${existing.status}`;
  const ctx = await buildChecklistContext("WORK_ORDER", wo.id);
  const template = await findBestTemplate({ category: ctx.category, workType: ctx.workType });
  if (!template) return "no matching approved template";
  try {
    const result = await generateChecklistDraft({
      actorId: null, actorEmail, sourceType: "WORK_ORDER", sourceId: wo.id, mode: "TEMPLATE", templateId: template.id,
    });
    return `generated ${result.code} from template (${result.status})`;
  } catch {
    return "auto generation failed";
  }
}

/**
 * AUTO mode for a newly created complaint (§23: "Complaint Created → Generate
 * Draft Checklist"). Template-first; AI only when checklist_ai_enabled is on.
 * The draft waits in review — it attaches to the complaint's work order once approved.
 */
export async function autoGenerateForSource(sourceType: "COMPLAINT" | "IRMS", sourceId: string, actorEmail = "SYSTEM"): Promise<string> {
  const existing = await findInstanceForSource(sourceType, sourceId);
  if (existing && !["REJECTED"].includes(existing.status)) return `instance already ${existing.status}`;
  const ctx = await buildChecklistContext(sourceType, sourceId);
  const template = await findBestTemplate({ category: ctx.category, workType: ctx.workType });
  try {
    const result = await generateChecklistDraft({
      actorId: null, actorEmail, sourceType, sourceId,
      mode: template ? "TEMPLATE" : "AI_ASSIST",
      templateId: template?.id,
    });
    return `generated ${result.code} (${result.origin}, ${result.status})`;
  } catch {
    // §73 — neither template nor AI produced a draft; the manual path remains.
    return "no template match and AI unavailable";
  }
}
