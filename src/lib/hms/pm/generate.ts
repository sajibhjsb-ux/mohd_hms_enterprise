// MOHD.HMS ENTERPRISE — PM occurrence generator (spec §22/§23/§61).
// ONE authoritative implementation used by BOTH the manual generate route and
// the automatic scheduler/workflow engine, so the PM→Work-Order bridge behaves
// identically everywhere and occurrence creation is idempotent:
//   - unique occurrence key (planId + occurrenceKey)
//   - open-task re-check (a plan never has two open occurrences)
// Every occurrence creates its execution Work Order (sourceType=PM) with the
// checklist snapshot copied from the plan template — the canonical Work Order
// system owns accept/start/complete, materials, stock and labour.

import "server-only";
import { db } from "@/lib/db";
import { audit, nextNumber, notify, notifyRole } from "@/lib/hms/services";
import { computeNextCalendarDue, computeNextDue, isMeterPlanType, parseChecklistTemplate, mapPriorityToWo } from "./schedule";

export type GenerateOccurrenceResult =
  | { created: true; taskId: string; taskCode: string; workOrderId: string; workOrderCode: string; dueDate: Date; nextDueDate: Date | null; nextDueMeter: number | null }
  | { created: false; reason: string; existingTaskId?: string; existingTaskCode?: string };

const OPEN_TASK_STATUSES = ["SCHEDULED", "OVERDUE", "IN_PROGRESS"];

export class PmGenerateError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type RequiredPart = { inventoryItemId?: string | null; name: string; quantity: number; unit?: string; unitCostCents?: number };

/** Safely parse the plan's requiredParts JSON (Inventory spec §41). */
function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Generate the next PM occurrence for a plan (idempotent).
 * - occurrenceKey: calendar plans default to the due day (`cal:YYYY-MM-DD`),
 *   meter plans to the crossing threshold (`meter:<nextDueMeter>`). Running the
 *   generator twice for the same occurrence never creates two tasks/work orders.
 * - dueDate: override for manual generation (defaults to the plan's next due).
 */
export async function generatePmOccurrence(opts: {
  planId: string;
  actorId?: string;
  actorEmail?: string;
  occurrenceKey?: string;
  dueDate?: Date;
  source: "MANUAL" | "AUTO";
}): Promise<GenerateOccurrenceResult> {
  const plan = await db.pmPlan.findUnique({
    where: { id: opts.planId },
    include: {
      equipment: { include: { customer: { select: { id: true, companyName: true, code: true } } } },
      assignedTechnician: { include: { user: { select: { id: true, name: true } } } },
      meter: { select: { id: true, currentReading: true, name: true, unit: true } },
    },
  });
  if (!plan) throw new PmGenerateError("NOT_FOUND", "PM plan not found.");
  if (!plan.active) throw new PmGenerateError("INACTIVE", "PM plan is inactive. Activate it before generating occurrences.");
  if (isMeterPlanType(plan.planType) && (!plan.meterId || !plan.meterInterval || plan.meterInterval <= 0)) {
    throw new PmGenerateError("METER_CONFIG", "Meter-based plans need a linked meter and a service interval.");
  }

  const dueDate = opts.dueDate ?? plan.nextDueDate ?? new Date();
  const occurrenceKey =
    opts.occurrenceKey ??
    (isMeterPlanType(plan.planType) ? `meter:${plan.nextDueMeter ?? plan.meterInterval}` : `cal:${isoDay(dueDate)}`);

  // Idempotency layer 1 — the same occurrence identity already exists.
  const sameOccurrence = await db.pmTask.findUnique({
    where: { planId_occurrenceKey: { planId: plan.id, occurrenceKey } },
    select: { id: true, code: true },
  });
  if (sameOccurrence) {
    return { created: false, reason: "occurrence already exists", existingTaskId: sameOccurrence.id, existingTaskCode: sameOccurrence.code };
  }
  // Idempotency layer 2 — a plan never carries two open occurrences.
  const openTask = await db.pmTask.findFirst({
    where: { planId: plan.id, status: { in: OPEN_TASK_STATUSES } },
    select: { id: true, code: true },
  });
  if (openTask) {
    return { created: false, reason: `open task ${openTask.code} already exists`, existingTaskId: openTask.id, existingTaskCode: openTask.code };
  }

  // Checklist snapshot — rich items from the plan template (§17/§54).
  const items = parseChecklistTemplate(plan.checklistTemplate);
  if (items.length === 0) {
    throw new PmGenerateError("NO_CHECKLIST", "Add at least one checklist item to the plan before generating an occurrence.");
  }

  // §13 — the canonical equipment record owns the customer link; a PM work
  // order must always carry a customer (WorkOrder.customerId is required).
  if (!plan.equipment.customerId) {
    throw new PmGenerateError("NO_CUSTOMER", `Equipment ${plan.equipment.assetTag} has no customer assigned. Assign a customer before scheduling PM.`);
  }

  const taskCode = await nextNumber("PMT");
  const woCode = await nextNumber("WO");

  const created = await db.$transaction(async (tx) => {
    const task = await tx.pmTask.create({
      data: {
        code: taskCode,
        planId: plan.id,
        equipmentId: plan.equipmentId,
        technicianId: plan.assignedTechnicianId ?? null,
        dueDate,
        priority: plan.priority,
        occurrenceKey,
        status: "SCHEDULED",
      },
    });
    const workOrder = await tx.workOrder.create({
      data: {
        code: woCode,
        customerId: plan.equipment.customerId as string,
        equipmentId: plan.equipmentId,
        technicianId: plan.assignedTechnicianId ?? null,
        title: `[PM] ${plan.name} — ${plan.equipment.name}`,
        description: [
          `Preventive maintenance from plan ${plan.code} (${plan.name}).`,
          plan.instructions ? `Instructions: ${plan.instructions}` : "",
          plan.safetyRequirements ? `Safety: ${plan.safetyRequirements}` : "",
        ].filter(Boolean).join("\n"),
        priority: mapPriorityToWo(plan.priority),
        sourceType: "PM",
        status: "PENDING",
        scheduledDate: dueDate,
        pmTaskId: task.id,
      },
    });
    if (items.length > 0) {
      await tx.workOrderChecklistItem.createMany({
        data: items.map((item, i) => ({
          workOrderId: workOrder.id,
          label: item.label,
          required: item.required,
          responseType: item.responseType,
          done: false,
          sortOrder: i,
        })),
      });
    }
    // Inventory spec §41 — materialize the plan's requiredParts into canonical
    // WorkOrderMaterial rows (REQUESTED — no stock effect until issued). Parts
    // carrying an inventoryItemId link to the ONE canonical catalog item.
    const requiredParts = parseJsonArray<RequiredPart>(plan.requiredParts);
    if (requiredParts.length > 0) {
      await tx.workOrderMaterial.createMany({
        data: requiredParts.map((p) => {
          const unitCostCents = p.unitCostCents ?? 0;
          return {
            workOrderId: workOrder.id,
            inventoryItemId: p.inventoryItemId ?? null,
            name: p.name,
            quantity: p.quantity,
            unit: p.unit || "pcs",
            unitCostCents,
            totalCents: Math.round(p.quantity * unitCostCents),
            status: "REQUESTED",
          };
        }),
      });
    }
    // §31 — backend-authoritative next-due advance (calendar → next date,
    // meter → next threshold). If completion drifted past the next computed
    // date the calendar rolls forward from the occurrence due date instead of
    // silently hiding overdue cycles.
    const next = computeNextDue(plan, dueDate);
    let nextDueDate: Date | null = null;
    let nextDueMeter: number | null = null;
    if (next.nextDueDate) nextDueDate = next.nextDueDate;
    if (typeof next.nextDueMeter === "number") nextDueMeter = next.nextDueMeter;
    await tx.pmPlan.update({
      where: { id: plan.id },
      data: {
        ...(nextDueDate ? { nextDueDate: rollForward(nextDueDate, dueDate, plan) ?? nextDueDate } : {}),
        ...(nextDueMeter !== null ? { nextDueMeter } : {}),
      },
    });
    return { task, workOrder, nextDueDate, nextDueMeter };
  });

  await audit({
    actorId: opts.actorId,
    actorEmail: opts.actorEmail ?? "SYSTEM",
    action: "PM_TASK_GENERATED",
    resourceType: "PM_TASK",
    resourceId: created.task.id,
    metadata: {
      taskCode: created.task.code,
      planCode: plan.code,
      workOrderCode: created.workOrder.code,
      dueDate: dueDate.toISOString(),
      nextDueDate: created.nextDueDate?.toISOString() ?? null,
      nextDueMeter: created.nextDueMeter,
      source: opts.source,
      occurrenceKey,
    },
  });

  if (plan.assignedTechnician?.user?.id) {
    await notify({
      userId: plan.assignedTechnician.user.id,
      title: "PM task scheduled",
      message: `${created.task.code} — ${plan.name} on ${plan.equipment.name} is due ${isoDay(dueDate)}. Work order ${created.workOrder.code} is awaiting your acceptance.`,
      type: "INFO",
      resourceType: "PM_TASK",
      resourceId: created.task.id,
    });
  }
  await notifyRole("SUPERVISOR", {
    title: opts.source === "AUTO" ? "PM task auto-generated" : "PM task generated",
    message: `Task ${created.task.code} generated from plan ${plan.code} (due ${isoDay(dueDate)}), work order ${created.workOrder.code}.`,
    type: "INFO",
    resourceType: "PM_TASK",
    resourceId: created.task.id,
  });

  return {
    created: true,
    taskId: created.task.id,
    taskCode: created.task.code,
    workOrderId: created.workOrder.id,
    workOrderCode: created.workOrder.code,
    dueDate,
    nextDueDate: created.nextDueDate,
    nextDueMeter: created.nextDueMeter,
  };
}

/** Keep the published cadence ahead of reality — never schedule the next cycle in the past. */
function rollForward(nextDue: Date, fromDue: Date, plan: { planType: string; frequency: string; customIntervalDays?: number | null; intervalUnits?: number | null; intervalUnit?: string | null; monthlyOccurrence?: string | null; monthlyWeekday?: number | null; endDate?: Date | null }): Date | null {
  if (nextDue > fromDue) return nextDue;
  let cursor = fromDue;
  for (let i = 0; i < 12; i++) {
    const candidate = computeNextCalendarDue(plan, cursor);
    if (!candidate) return null;
    if (candidate > fromDue) return candidate;
    cursor = candidate;
  }
  return null;
}
