// MOHD.HMS ENTERPRISE — Work order workflow transitions (server-side enforced).
// accept | start | hold | resume | complete | cancel
// On completion: recompute totals and deduct inventoried material stock inside a
// single $transaction (idempotent — the from-status guard rejects double runs).
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors, ApiError } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { WO_TRANSITIONS, PERMISSIONS } from "@/lib/hms/constants";
import { automationNumber } from "@/lib/hms/workflows/settings";
import type { SessionUser } from "@/lib/hms/auth";
import { WO_DETAIL_INCLUDE, assertViewWorkOrder, isAssignedTechnician, isSupervisorPlus, assertWoTransition } from "../../_lib";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { emit } from "@/lib/hms/workflows/bus";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";
import { syncComplaintFromWorkOrder, reopenComplaintFromWorkOrder } from "@/lib/hms/workflows/complaint-work-order";
import { computeNextDue } from "@/lib/hms/pm/schedule";
import { applyStockMovement, consumeReservation } from "@/lib/hms/inventory";
import { validateChecklistForSubmission, type ChecklistExecutionItem } from "@/lib/hms/checklist/execution";
import {
  notifyWoAccepted,
  notifyComplaintUser,
  notifyWorkOrderStaff,
  notifyWoStarted,
  notifyWoOnHold,
  notifyWoSubmitted,
  notifyWoClosed,
  notifyWoReopened,
} from "@/lib/hms/complaint-notifications";

/** Consume this WO's active reservation for an item inside the caller's transaction. */
function consumeReservationInTx(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], itemId: string, quantity: number, workOrderId: string) {
  return consumeReservation(itemId, quantity, workOrderId, tx);
}

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

const transitionSchema = z.object({
  action: z.enum(["accept", "start", "hold", "resume", "complete", "close", "reopen", "return", "cancel"]),
  note: z.string().max(2000).optional(),
  reason: z.string().max(2000).optional(),
});

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, transitionSchema);
    if (body.action === "complete") dedupeSubmission({ userId: user.id, route: "POST /api/v1/work-orders/[id]/transition:complete", body: { id, note: body.note } });
    const wo = await db.workOrder.findUnique({ where: { id }, include: WO_DETAIL_INCLUDE });
    if (!wo) throw Errors.notFound("Work order not found.");
    await assertViewWorkOrder(user, wo);

    const from = wo.status;
    const now = new Date();
    const assigned = await isAssignedTechnician(user, wo.technicianId);
    const portalUserId = wo.customer.portalUser?.id ?? null;
    const code = wo.code;

    // Role gates per action
    if (body.action === "accept" || body.action === "start" || body.action === "hold" || body.action === "resume") {
      const allowed = assigned || roleCan(user.role, PERMISSIONS.work_orders_update);
      if (!allowed) throw Errors.forbidden(`Only the assigned technician can ${body.action} this work order.`);
    }
    if (body.action === "complete") {
      const allowed = assigned || roleCan(user.role, PERMISSIONS.work_orders_complete);
      if (!allowed) throw Errors.forbidden();
    }
    if (body.action === "close" || body.action === "reopen" || body.action === "return") {
      // Review/closure/return is a supervisor-or-above responsibility.
      // Technicians may submit (complete) but must never approve their own work,
      // even via API.
      if (!isSupervisorPlus(user.role)) {
        throw Errors.forbidden("Only a supervisor or manager can close, reopen or return a work order.");
      }
    }
    if (body.action === "cancel") {
      const allowed = assigned || roleCan(user.role, PERMISSIONS.work_orders_assign);
      if (!allowed) throw Errors.forbidden();
    }

    switch (body.action) {
      case "accept": {
        assertWoTransition("ACCEPTED", from, WO_TRANSITIONS);
        const updated = await db.workOrder.update({
          where: { id }, data: { status: "ACCEPTED" }, include: WO_DETAIL_INCLUDE,
        });
        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_ACCEPTED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code } });
        await notifyWoAccepted({
          workOrderId: id,
          workOrderCode: code,
          complaintId: wo.complaintId ?? null,
          complaintCode: wo.complaint?.code ?? null,
          acceptedBy: user.name,
          customerId: wo.customerId,
          createdById: wo.customer?.portalUser?.id ?? "",
          technicianUserId: updated.technician?.user?.id ?? null,
        });
        await emit({ type: EVENT_TYPES.WORK_ORDER_ACCEPTED, resourceType: "WORK_ORDER", resourceId: id, payload: { code, workOrderId: id }, actorType: "USER", actorId: user.id });
        await notifyRole("SUPERVISOR", { title: "Work order accepted", message: `${code} accepted by ${user.name}.`, type: "INFO", resourceType: "WORK_ORDER", resourceId: id });
        return ok(updated);
      }

      case "start": {
        assertWoTransition("IN_PROGRESS", from, WO_TRANSITIONS);
        if (from === "CLOSED") {
          throw Errors.invalidTransition("A closed work order can only be reopened by a supervisor using the reopen action.");
        }

        // ── §15/§18 — PRE-WORK GATE (backend-authoritative, never UI-only) ──
        // Starting work requires: (1) a configurable minimum number of REAL
        // before-work media records persisted in object storage (verified by
        // counting Document rows — a `photoUploaded` boolean is never trusted),
        // and (2) every required checklist item answered (rich required
        // responses recorded). Failures block the transition with a structured
        // `missing` details array the UI surfaces per requirement.
        const missing: string[] = [];

        const beforePhotosMin = await automationNumber("start_work_before_photos_min", 1);
        let photoCount = 0;
        if (beforePhotosMin > 0) {
          // At start time every photo on the work order IS a before-work photo
          // (DURING/AFTER evidence only becomes possible after start). Count the
          // actual persisted rows — metadata created only after the bytes landed.
          // Only IMAGES satisfy the photo requirement (videos are media, not photos).
          photoCount = await db.document.count({
            where: { resourceType: "WORK_ORDER", resourceId: id, category: "WORK_ORDER", mimeType: { startsWith: "image/" } },
          });
          // §15/§40 — evidence the customer/staff already attached to the SOURCE
          // COMPLAINT counts as before-work evidence too: the same fault was
          // documented at intake, so the technician is not asked to re-shoot it.
          if (wo.complaintId) {
            photoCount += await db.document.count({
              where: {
                resourceType: "COMPLAINT",
                resourceId: wo.complaintId,
                category: "COMPLAINT",
                mimeType: { startsWith: "image/" },
              },
            });
          }
          if (photoCount < beforePhotosMin) {
            missing.push(`Before-work photo evidence (${photoCount}/${beforePhotosMin} required)`);
          }
        }

        const startItems = await db.workOrderChecklistItem.findMany({
          where: { workOrderId: id, removedAt: null },
          select: { id: true, label: true, status: true, statusReason: true, done: true, required: true, responseType: true, response: true, notes: true, requiresPhoto: true, failRequiresFinding: true, safetyCritical: true },
        });
        const startValidation = validateChecklistForSubmission(startItems as unknown as ChecklistExecutionItem[], {}, "START");
        // §16/§31 — ONLY required items block the start; optional items stay
        // advisory (the UI shows completion counts either way).
        if (startItems.length === 0) {
          missing.push("No pre-work checklist attached — generate one with AI, use a template, or add items manually");
        } else if (!startValidation.ok) {
          missing.push(...startValidation.missing);
        }

        if (missing.length > 0) {
          // §29 — structured response, NOT a generic error. Built here directly
          // (not via ApiError) so the full payload reaches non-admin callers too:
          // handler()'s safeErrorMessage strips `details` for everyone except
          // SUPER_ADMIN, and the assigned technician is exactly who needs it.
          // `requirements` mirrors the §29 contract; `missing` carries the human
          // per-requirement list the UI renders.
          const requirements = {
            before_work_photos: {
              required: beforePhotosMin > 0,
              completed: beforePhotosMin === 0 || photoCount >= beforePhotosMin,
              current: photoCount,
              minimum: beforePhotosMin,
            },
            checklist: {
              required: true,
              completed: startItems.length > 0 && startValidation.ok,
              requiredTotal: startItems.filter((c) => c.required).length,
              requiredDone: startItems.filter((c) => c.required && c.done && (c.responseType === "CHECKBOX" || c.response.trim() !== "")).length,
            },
          };
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "WORK_ORDER_START_REQUIREMENTS_NOT_MET",
                message: `Cannot start work. Missing: ${missing.slice(0, 3).join("; ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""}.`,
                requirements,
                details: { missing, requirements },
              },
            },
            { status: 422 },
          );
        }

        const updated = await db.$transaction(async (tx) => {
          const row = await tx.workOrder.update({
            where: { id }, data: { status: "IN_PROGRESS", startedAt: now }, include: WO_DETAIL_INCLUDE,
          });
          // Rule C — the linked complaint follows the authoritative work order
          // into IN_PROGRESS (monotonic; history row written by the helper).
          if (row.complaintId) {
            await syncComplaintFromWorkOrder(tx, { workOrderId: id, changedById: user.id, note: `Work order ${code} started` });
          }
          // PM §25 — mirror the canonical work-order state onto the PM occurrence.
          if (row.pmTaskId) {
            await tx.pmTask.updateMany({
              where: { id: row.pmTaskId, status: { in: ["SCHEDULED", "OVERDUE"] } },
              data: { status: "IN_PROGRESS" },
            });
          }
          return row;
        });
        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_STARTED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code } });
        await notifyWoStarted({
          workOrderId: id,
          workOrderCode: code,
          complaintId: wo.complaintId ?? null,
          complaintCode: wo.complaint?.code ?? null,
          startedBy: user.name,
          customerId: wo.customerId,
          createdById: wo.customer?.portalUser?.id ?? "",
          technicianUserId: updated.technician?.user?.id ?? null,
        });
        await emit({ type: EVENT_TYPES.WORK_ORDER_STARTED, resourceType: "WORK_ORDER", resourceId: id, payload: { code, workOrderId: id }, actorType: "USER", actorId: user.id });
        await notifyRole("SUPERVISOR", { title: "Work order started", message: `${code} started by ${user.name}.`, type: "INFO", resourceType: "WORK_ORDER", resourceId: id });
        return ok(updated);
      }

      case "hold": {
        assertWoTransition("ON_HOLD", from, WO_TRANSITIONS);
        const updated = await db.workOrder.update({
          where: { id }, data: { status: "ON_HOLD", ...(body.note ? { notes: body.note } : {}) }, include: WO_DETAIL_INCLUDE,
        });
        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_ON_HOLD", resourceType: "WORK_ORDER", resourceId: id, metadata: { code, note: body.note ?? "" } });
        await notifyWoOnHold({
          workOrderId: id,
          workOrderCode: code,
          complaintId: wo.complaintId ?? null,
          complaintCode: wo.complaint?.code ?? null,
          holdReason: body.note ?? null,
          heldBy: user.name,
          customerId: wo.customerId,
          createdById: wo.customer?.portalUser?.id ?? "",
          technicianUserId: updated.technician?.user?.id ?? null,
        });
        await emit({ type: EVENT_TYPES.WORK_ORDER_ON_HOLD, resourceType: "WORK_ORDER", resourceId: id, payload: { code, workOrderId: id }, actorType: "USER", actorId: user.id });
        await notifyRole("SUPERVISOR", { title: "Work order on hold", message: `${code} put on hold by ${user.name}.${body.note ? ` Note: ${body.note}` : ""}`, type: "WARNING", resourceType: "WORK_ORDER", resourceId: id });
        return ok(updated);
      }

      case "resume": {
        assertWoTransition("IN_PROGRESS", from, WO_TRANSITIONS);
        if (from === "CLOSED") {
          throw Errors.invalidTransition("A closed work order can only be reopened by a supervisor using the reopen action.");
        }
        const updated = await db.workOrder.update({
          where: { id }, data: { status: "IN_PROGRESS" }, include: WO_DETAIL_INCLUDE,
        });
        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_RESUMED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code } });
        await notifyWorkOrderStaff({
          workOrderId: id,
          workOrderCode: code,
          eventType: EVENT_TYPES.WORK_ORDER_STARTED,
          title: "Work Resumed",
          message: `Work on Work Order ${code} has been resumed by ${user.name}.`,
          type: "INFO",
        });
        if (wo.complaintId) {
          await notifyComplaintUser({
            userId: wo.customerId,
            complaintId: wo.complaintId,
            complaintCode: wo.complaint?.code ?? "",
            eventType: EVENT_TYPES.WORK_ORDER_STARTED,
            title: "Work Resumed",
            message: `Work on your ${wo.complaint?.code ? `complaint ${wo.complaint.code} ` : ""}(Work Order ${code}) has been resumed by ${user.name}.`,
            type: "INFO",
          });
        }
        await emit({ type: EVENT_TYPES.WORK_ORDER_STARTED, resourceType: "WORK_ORDER", resourceId: id, payload: { code, workOrderId: id }, actorType: "USER", actorId: user.id });
        return ok(updated);
      }

      case "complete": {
        // Technician submission for supervisor review. NOT final approval: the
        // complaint is not closed and no invoice is generated until CLOSED.
        assertWoTransition("COMPLETED", from, WO_TRANSITIONS);
        const { updated } = await db.$transaction(async (tx) => {
          // Re-read inside the transaction — guards idempotency (a concurrent
          // completion flips the status and this update throws via the guard below).
          const current = await tx.workOrder.findUnique({
            where: { id },
            include: { materials: true, customer: { select: { id: true, portalUser: { select: { id: true } } } } },
          });
          if (!current) throw Errors.notFound("Work order not found.");
          if (current.status !== "IN_PROGRESS") {
            throw Errors.invalidTransition(`${current.status} → COMPLETED is not allowed`);
          }

          // Totals from current rows
          const materialsTotalCents = current.materials.reduce((s, m) => s + m.totalCents, 0);
          const labourTotalCents = Math.round(current.labourHours * current.labourRateCents);
          const totalCents = labourTotalCents + materialsTotalCents;

          // §15/§17 — checklist enforcement is BACKEND-authoritative: a work order
          // with unfinished checklist items cannot be completed, regardless of UI.
          // For required rich items (PASSFAIL/YESNO/NUMERIC/TEXT) a recorded
          // response is also mandatory — an unticked required item blocks completion.
          // Checklist engine §32 — required photos + failed-task notes also block.
          const items = await tx.workOrderChecklistItem.findMany({
            where: { workOrderId: id, removedAt: null },
            select: { id: true, label: true, status: true, statusReason: true, done: true, required: true, responseType: true, response: true, notes: true, requiresPhoto: true, failRequiresFinding: true, safetyCritical: true },
          });
          const photoCounts: Record<string, number> = {};
          const photoItems = items.filter((c) => c.requiresPhoto);
          if (photoItems.length > 0) {
            const photoRows = await tx.document.findMany({
              where: {
                resourceType: "WORK_ORDER",
                resourceId: id,
                category: "WORK_ORDER",
                label: { in: photoItems.map((c) => c.id) },
              },
              select: { label: true },
            });
            for (const p of photoRows) photoCounts[p.label] = (photoCounts[p.label] ?? 0) + 1;
          }
          const validation = validateChecklistForSubmission(items as unknown as ChecklistExecutionItem[], photoCounts, "SUBMIT");
          if (!validation.ok) {
            throw new ApiError(
              422,
              "INVALID_TRANSITION",
              `Cannot complete work order. Missing: ${validation.missing.slice(0, 5).join("; ")}${validation.missing.length > 5 ? "…" : ""}.`,
              { missing: validation.missing },
            );
          }

          // §15/§40 — completion is provable: at least one AFTER (completion)
          // photo or video must exist before the work order can be completed.
          // Distinct error code so the client can prompt for the capture.
          const completionEvidence = await tx.document.count({
            where: { resourceType: "WORK_ORDER", resourceId: id, category: "WORK_ORDER", label: "AFTER" },
          });
          if (completionEvidence < 1) {
            throw new ApiError(
              422,
              "COMPLETION_EVIDENCE_REQUIRED",
              "A completion photo or video is required before this work order can be completed.",
              { required: 1, present: completionEvidence },
            );
          }

          // Inventory spec §11/§12 — stock leaves ONLY through the central engine
          // (applyStockMovement). Still-REQUESTED lines auto-issue here (approved
          // legacy behavior: add material → complete → deduct); RESERVED lines
          // consume their reservation first; ISSUED/USED/RETURNED/CANCELLED lines
          // already settled. Insufficient stock REJECTS completion (§70).
          const lowStock: { id: string }[] = [];
          for (const m of current.materials) {
            if (!m.inventoryItemId) continue;
            if (["ISSUED", "USED", "RETURNED", "CANCELLED"].includes(m.status)) continue;
            const item = await tx.inventoryItem.findUnique({
              where: { id: m.inventoryItemId },
              select: { id: true, sku: true, stockQty: true, minStockQty: true, reorderLevel: true, stockType: true },
            });
            if (!item || item.stockType === "NON_STOCK") continue;
            const consumeReservations = m.status === "RESERVED";
            if (consumeReservations) await consumeReservationInTx(tx, item.id, m.quantity, current.id);
            const mv = await applyStockMovement(tx, {
              itemId: item.id,
              type: "ISSUE",
              signedQuantity: -m.quantity,
              referenceType: "WORK_ORDER",
              referenceId: current.id,
              note: `${current.code} — ${m.name} (auto-issue at completion)`,
              createdById: user.id,
            });
            await tx.workOrderMaterial.update({
              where: { id: m.id },
              data: { status: "ISSUED", issuedQty: Math.round((m.issuedQty + m.quantity) * 100) / 100 },
            });
            // §17/§43 — flag items that dropped to/below the reorder point after this issue.
            if (mv.lowStock || mv.outOfStock) lowStock.push({ id: item.id });
          }

          // Stock consumption is final at technician submission. The invoice /
          // completion event is NOT emitted here: a supervisor must first
          // approve and CLOSE the work order (see the close case below).
          for (const item of lowStock) {
            await tx.domainEvent.create({
              data: {
                type: EVENT_TYPES.LOW_STOCK, resourceType: "INVENTORY_ITEM", resourceId: item.id,
                payload: JSON.stringify({ source: "WORK_ORDER", workOrderCode: current.code }),
                actorType: "SYSTEM",
              },
            });
          }

          const row = await tx.workOrder.update({
            where: { id },
            data: { status: "COMPLETED", completedAt: now, labourTotalCents, materialsTotalCents, totalCents, ...(body.note ? { notes: body.note } : {}) },
            include: WO_DETAIL_INCLUDE,
          });

          // §8 — technician submission timestamps the checklist instance.
          const inst = await tx.checklistInstance.findUnique({ where: { workOrderId: id }, select: { id: true, code: true, status: true } });
          if (inst && inst.status === "ACTIVE") {
            await tx.checklistInstance.update({ where: { id: inst.id }, data: { submittedAt: now } });
          }

          return { updated: row, lowStockItems: lowStock };
        });

        // Submitted for review — the supervisor decides whether it is accepted.
        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_SUBMITTED_FOR_REVIEW", resourceType: "WORK_ORDER", resourceId: id, metadata: { code, totalCents: updated.totalCents } });
        const submittedInst = await db.checklistInstance.findUnique({ where: { workOrderId: id }, select: { id: true, code: true } });
        if (submittedInst) {
          await audit({ actorId: user.id, actorEmail: user.email, action: "CHECKLIST_SUBMITTED", resourceType: "CHECKLIST_INSTANCE", resourceId: submittedInst.id, metadata: { code: submittedInst.code, workOrderCode: code } });
        }
        await notifyWoSubmitted({
          workOrderId: id,
          workOrderCode: code,
          complaintId: wo.complaintId ?? null,
          complaintCode: wo.complaint?.code ?? null,
          submittedBy: user.name,
          customerId: wo.customerId,
          createdById: wo.customer?.portalUser?.id ?? "",
          technicianUserId: wo.technician?.user?.id ?? null,
        });
        await emit({ type: EVENT_TYPES.WORK_ORDER_SUBMITTED, resourceType: "WORK_ORDER", resourceId: id, payload: { code, workOrderId: id }, actorType: "USER", actorId: user.id });
        await notifyRole("SUPERVISOR", {
          title: "Work order awaiting review",
          message: `${code} was submitted by ${user.name}. Review the evidence, then approve and close it.`,
          type: "INFO", resourceType: "WORK_ORDER", resourceId: id,
        });
        return ok(updated);
      }

      case "close": {
        // Supervisor/manager final approval. Re-verifies the completion gates
        // inside the transaction (never trust an earlier client/tech state),
        // then closes the linked complaint and releases the invoice event.
        assertWoTransition("CLOSED", from, WO_TRANSITIONS);

        // §3 — AFTER WORK evidence is mandatory before final closure. At least
        // one saved AFTER photo or video must exist (backend verifies real
        // persisted records, never a frontend boolean).
        const afterEvidence = await db.document.count({
          where: {
            resourceType: "WORK_ORDER",
            resourceId: id,
            category: "WORK_ORDER",
            label: "AFTER",
          },
        });
        if (afterEvidence < 1) {
          throw new ApiError(
            422,
            "AFTER_EVIDENCE_REQUIRED",
            "At least one completion photo or video is required before this work order can be closed.",
            { required: 1, present: afterEvidence },
          );
        }
        const ref: {
          completedInstance: { id: string; code: string } | null;
          autoClosedComplaint: { id: string; code: string; fromStatus: string } | null;
        } = { completedInstance: null, autoClosedComplaint: null };

        const updated = await db.$transaction(async (tx) => {
          const current = await tx.workOrder.findUnique({
            where: { id },
            include: { materials: true, customer: { select: { id: true, portalUser: { select: { id: true } } } } },
          });
          if (!current) throw Errors.notFound("Work order not found.");
          if (current.status !== "COMPLETED") {
            throw Errors.invalidTransition(`${current.status} → CLOSED is not allowed`);
          }

          const items = await tx.workOrderChecklistItem.findMany({
            where: { workOrderId: id, removedAt: null },
            select: { id: true, label: true, status: true, statusReason: true, done: true, required: true, responseType: true, response: true, notes: true, requiresPhoto: true, failRequiresFinding: true, safetyCritical: true },
          });
          const photoCounts: Record<string, number> = {};
          const photoItems = items.filter((c) => c.requiresPhoto);
          if (photoItems.length > 0) {
            const photoRows = await tx.document.findMany({
              where: {
                resourceType: "WORK_ORDER",
                resourceId: id,
                category: "WORK_ORDER",
                label: { in: photoItems.map((c) => c.id) },
              },
              select: { label: true },
            });
            for (const p of photoRows) photoCounts[p.label] = (photoCounts[p.label] ?? 0) + 1;
          }
          const validation = validateChecklistForSubmission(items as unknown as ChecklistExecutionItem[], photoCounts, "SUBMIT");
          if (!validation.ok) {
            throw new ApiError(
              422,
              "INVALID_TRANSITION",
              `Cannot close work order. Missing: ${validation.missing.slice(0, 5).join("; ")}${validation.missing.length > 5 ? "…" : ""}.`,
              { missing: validation.missing },
            );
          }
          const completionEvidence = await tx.document.count({
            where: { resourceType: "WORK_ORDER", resourceId: id, category: "WORK_ORDER", label: "AFTER" },
          });
          if (completionEvidence < 1) {
            throw new ApiError(
              422,
              "COMPLETION_EVIDENCE_REQUIRED",
              "A completion photo or video is required before this work order can be closed.",
              { required: 1, present: completionEvidence },
            );
          }

          const materialsTotalCents = current.materials.reduce((s, m) => s + m.totalCents, 0);
          const labourTotalCents = Math.round(current.labourHours * current.labourRateCents);
          const totalCents = labourTotalCents + materialsTotalCents;

          const row = await tx.workOrder.update({
            where: { id },
            data: {
              status: "CLOSED",
              closedAt: now,
              approvedAt: now,
              approvedById: user.id,
              labourTotalCents,
              materialsTotalCents,
              totalCents,
              ...(body.note ? { notes: body.note } : {}),
            },
            include: WO_DETAIL_INCLUDE,
          });

          // PM §2/§25/§31 — the occurrence is settled only on approved closure.
          if (current.pmTaskId) {
            const task = await tx.pmTask.findUnique({ where: { id: current.pmTaskId }, include: { plan: true } });
            if (task && task.status !== "COMPLETED" && task.status !== "SKIPPED" && task.status !== "CANCELLED") {
              await tx.pmTask.update({ where: { id: task.id }, data: { status: "COMPLETED", completedAt: now } });
              const plan = task.plan;
              if (plan) {
                const next = computeNextDue(plan, task.dueDate);
                await tx.pmPlan.update({
                  where: { id: plan.id },
                  data: {
                    lastCompletedAt: now,
                    ...(next.nextDueDate ? { nextDueDate: next.nextDueDate > now ? next.nextDueDate : task.dueDate } : {}),
                    ...(typeof next.nextDueMeter === "number" ? { nextDueMeter: next.nextDueMeter } : {}),
                  },
                });
              }
            }
          }
          // Checklist engine — completes with the approved closure (§36/§51).
          const inst = await tx.checklistInstance.findUnique({ where: { workOrderId: id }, select: { id: true, code: true, status: true } });
          if (inst && inst.status === "ACTIVE") {
            await tx.checklistInstance.update({
              where: { id: inst.id },
              data: {
                status: "COMPLETED",
                completedAt: now,
                reviewedAt: now,
                reviewedById: user.id,
                reviewNotes: body.note ?? "",
              },
            });
            ref.completedInstance = { id: inst.id, code: inst.code };
          }

          // §15 — ONLY the final CLOSED state auto-closes the linked complaint.
          if (current.complaintId) {
            const closed = await syncComplaintFromWorkOrder(tx, {
              workOrderId: id,
              changedById: user.id,
              note: `Complaint automatically closed after linked Work Order ${current.code} was approved and closed.`,
            });
            if (closed) {
              await tx.domainEvent.create({
                data: {
                  type: EVENT_TYPES.COMPLAINT_CLOSED, resourceType: "COMPLAINT", resourceId: closed.id,
                  payload: JSON.stringify({ code: closed.code, reason: "WORK_ORDER_CLOSED", workOrderCode: current.code }),
                  actorType: "USER", actorId: user.id,
                },
              });
              ref.autoClosedComplaint = { id: closed.id, code: closed.code, fromStatus: closed.fromStatus };
            }
          }

          // Transactional outbox (§5): completion/invoicing becomes final only
          // now, together with the closure — never on technician submission.
          await tx.domainEvent.create({
            data: {
              type: EVENT_TYPES.WORK_ORDER_COMPLETED, resourceType: "WORK_ORDER", resourceId: id,
              payload: JSON.stringify({ code: current.code, totalCents, approvedById: user.id }),
              actorType: "USER", actorId: user.id,
            },
          });
          return row;
        });

        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_CLOSED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code, totalCents: updated.totalCents, approvedById: user.id } });
        await notifyWoClosed({
          workOrderId: id,
          workOrderCode: code,
          complaintId: wo.complaintId ?? null,
          complaintCode: wo.complaint?.code ?? null,
          closedBy: user.name,
          customerId: wo.customerId,
          createdById: wo.customer?.portalUser?.id ?? "",
          technicianUserId: wo.technician?.user?.id ?? null,
        });
        if (ref.autoClosedComplaint) {
          await audit({ actorId: user.id, actorEmail: user.email, action: "COMPLAINT_AUTO_CLOSED", resourceType: "COMPLAINT", resourceId: ref.autoClosedComplaint.id, metadata: { code: ref.autoClosedComplaint.code, reason: "Linked work order approved and closed", workOrderCode: code, fromStatus: ref.autoClosedComplaint.fromStatus } });
        }
        if (ref.completedInstance) {
          await audit({ actorId: user.id, actorEmail: user.email, action: "CHECKLIST_COMPLETED", resourceType: "CHECKLIST_INSTANCE", resourceId: ref.completedInstance.id, metadata: { code: ref.completedInstance.code, workOrderCode: code } });
          await emit({ type: EVENT_TYPES.CHECKLIST_COMPLETED, resourceType: "CHECKLIST_INSTANCE", resourceId: ref.completedInstance.id, payload: { code: ref.completedInstance.code, workOrderCode: code }, actorType: "USER", actorId: user.id });
        }
        if (updated.pmTaskId) {
          await audit({ actorId: user.id, actorEmail: user.email, action: "PM_COMPLETED", resourceType: "PM_TASK", resourceId: updated.pmTaskId, metadata: { taskCode: updated.pmTask?.code ?? null, workOrderCode: code } });
          await notifyRole("SUPERVISOR", { title: "PM completed", message: `PM occurrence ${updated.pmTask?.code ?? ""} (${code}) approved and closed by ${user.name}.`, type: "SUCCESS", resourceType: "PM_TASK", resourceId: updated.pmTaskId });
        }
        if (wo.technician?.user?.id && wo.technician.user.id !== user.id) {
          await notify({ userId: wo.technician.user.id, title: "Work order approved", message: `Work order ${code} was reviewed, approved and closed.`, type: "SUCCESS", resourceType: "WORK_ORDER", resourceId: id });
        }
        if (portalUserId) {
          await notify({ userId: portalUserId, title: "Work order completed", message: `Work order ${code} for your site has been completed and approved.`, type: "SUCCESS", resourceType: "WORK_ORDER", resourceId: id });
        }
        return ok(updated);
      }

      case "reopen": {
        assertWoTransition("IN_PROGRESS", from, WO_TRANSITIONS);
        const reason = (body.reason ?? body.note ?? "").trim();
        if (!reason) throw Errors.badRequest("A reopen reason is required.");
        const ref: { reopenedComplaint: { id: string; code: string } | null } = { reopenedComplaint: null };

        const updated = await db.$transaction(async (tx) => {
          const current = await tx.workOrder.findUnique({
            where: { id },
            select: { id: true, code: true, complaintId: true, pmTaskId: true, status: true },
          });
          if (!current) throw Errors.notFound("Work order not found.");
          if (current.status !== "CLOSED") {
            throw Errors.invalidTransition(`${current.status} → IN_PROGRESS (reopen) is not allowed`);
          }

          const row = await tx.workOrder.update({
            where: { id },
            data: {
              status: "IN_PROGRESS",
              reopenedAt: now,
              reopenReason: reason,
              // A reopened job is no longer approved/completed; new evidence and
              // a fresh supervisor approval are required before it can close again.
              closedAt: null,
              approvedAt: null,
              approvedById: null,
              completedAt: null,
              ...(body.note ? { notes: body.note } : {}),
            },
            include: WO_DETAIL_INCLUDE,
          });

          // ponytail: the PM occurrence is reopened, but the next-cycle date that
          // was advanced on closure is not rolled back (no previous value stored).
          // Add an occurrence snapshot if PM reopen dates must be exact.
          if (current.pmTaskId) {
            await tx.pmTask.updateMany({
              where: { id: current.pmTaskId, status: "COMPLETED" },
              data: { status: "IN_PROGRESS", completedAt: null },
            });
          }
          // The checklist must accept new evidence during the rework cycle.
          await tx.checklistInstance.updateMany({
            where: { workOrderId: id, status: "COMPLETED" },
            data: { status: "ACTIVE", completedAt: null, submittedAt: null, reviewedAt: null, reviewedById: null, reviewNotes: "" },
          });
          if (current.complaintId) {
            const reopened = await reopenComplaintFromWorkOrder(tx, {
              workOrderId: id,
              changedById: user.id,
              reason,
            });
            if (reopened) {
              await tx.domainEvent.create({
                data: {
                  type: EVENT_TYPES.COMPLAINT_UPDATED, resourceType: "COMPLAINT", resourceId: reopened.id,
                  payload: JSON.stringify({ code: reopened.code, status: reopened.toStatus, reason: "WORK_ORDER_REOPENED", workOrderCode: current.code }),
                  actorType: "USER", actorId: user.id,
                },
              });
              ref.reopenedComplaint = { id: reopened.id, code: reopened.code };
            }
          }
          return row;
        });

        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_REOPENED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code, reason } });
        await notifyWoReopened({
          workOrderId: id,
          workOrderCode: code,
          complaintId: wo.complaintId ?? null,
          complaintCode: wo.complaint?.code ?? null,
          reason,
          reopenedBy: user.name,
          customerId: wo.customerId,
          createdById: wo.customer?.portalUser?.id ?? "",
          technicianUserId: wo.technician?.user?.id ?? null,
        });
        await emit({ type: EVENT_TYPES.WORK_ORDER_REOPENED, resourceType: "WORK_ORDER", resourceId: id, payload: { code, workOrderId: id }, actorType: "USER", actorId: user.id });
        if (ref.reopenedComplaint) {
          await audit({ actorId: user.id, actorEmail: user.email, action: "COMPLAINT_REOPENED", resourceType: "COMPLAINT", resourceId: ref.reopenedComplaint.id, metadata: { code: ref.reopenedComplaint.code, reason, workOrderCode: code } });
        }
        if (wo.technician?.user?.id && wo.technician.user.id !== user.id) {
          await notify({ userId: wo.technician.user.id, title: "Work order reopened", message: `Work order ${code} was reopened by ${user.name}: ${reason}`, type: "WARNING", resourceType: "WORK_ORDER", resourceId: id });
        }
        if (portalUserId) {
          await notify({ userId: portalUserId, title: "Work order reopened", message: `Work order ${code} is being re-checked. Reason: ${reason}`, type: "WARNING", resourceType: "WORK_ORDER", resourceId: id });
        }
        return ok(updated);
      }

      case "return": {
        // Supervisor correction path: COMPLETED → IN_PROGRESS. It returns the
        // job to the technician for rework; it never emits the completion /
        // invoice event and never closes the linked complaint.
        assertWoTransition("IN_PROGRESS", from, WO_TRANSITIONS);
        if (from !== "COMPLETED") {
          throw Errors.invalidTransition("Return is only available for a submitted work order.");
        }
        const reason = (body.reason ?? body.note ?? "").trim();
        if (!reason) throw Errors.badRequest("A return reason is required.");

        const updated = await db.$transaction(async (tx) => {
          const current = await tx.workOrder.findUnique({
            where: { id },
            select: { id: true, code: true, status: true, technicianId: true },
          });
          if (!current) throw Errors.notFound("Work order not found.");
          if (current.status !== "COMPLETED") {
            throw Errors.invalidTransition(`${current.status} → IN_PROGRESS (return) is not allowed`);
          }

          const row = await tx.workOrder.update({
            where: { id },
            data: { status: "IN_PROGRESS", completedAt: null, ...(body.note ? { notes: body.note } : {}) },
            include: WO_DETAIL_INCLUDE,
          });

          await tx.checklistInstance.updateMany({
            where: { workOrderId: id },
            data: { status: "ACTIVE", completedAt: null, submittedAt: null, reviewedAt: null, reviewedById: null, reviewNotes: "" },
          });
          return row;
        });

        const inst = await db.checklistInstance.findUnique({ where: { workOrderId: id }, select: { id: true, code: true } });
        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_RETURNED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code, reason } });
        if (inst) {
          await audit({ actorId: user.id, actorEmail: user.email, action: "CHECKLIST_RETURNED", resourceType: "CHECKLIST_INSTANCE", resourceId: inst.id, metadata: { code: inst.code, workOrderCode: code, reason } });
        }
        await notifyWorkOrderStaff({
          workOrderId: id,
          workOrderCode: code,
          eventType: EVENT_TYPES.WORK_ORDER_ON_HOLD,
          title: "Work Order Returned",
          message: `Work Order ${code}${wo.complaint?.code ? ` for complaint ${wo.complaint.code}` : ""} was returned by ${user.name} for rework: ${reason}.`,
          type: "WARNING",
        });
        if (wo.complaintId) {
          await notifyComplaintUser({
            userId: wo.customerId,
            complaintId: wo.complaintId,
            complaintCode: wo.complaint?.code ?? "",
            eventType: EVENT_TYPES.WORK_ORDER_ON_HOLD,
            title: "Work Order Returned",
            message: `Your ${wo.complaint?.code ? `complaint ${wo.complaint.code} ` : ""}(Work Order ${code}) was returned for rework. Reason: ${reason}.`,
            type: "WARNING",
          });
        }
        if (updated.technician?.user?.id && updated.technician.user.id !== user.id) {
          await notify({ userId: updated.technician.user.id, title: "Work order returned", message: `Work order ${code} was returned by ${user.name} for rework: ${reason}`, type: "WARNING", resourceType: "WORK_ORDER", resourceId: id });
        }
        if (portalUserId) {
          await notify({ userId: portalUserId, title: "Work order returned", message: `Work order ${code} was returned for rework. Reason: ${reason}`, type: "WARNING", resourceType: "WORK_ORDER", resourceId: id });
        }
        await emit({ type: EVENT_TYPES.WORK_ORDER_ON_HOLD, resourceType: "WORK_ORDER", resourceId: id, payload: { code, workOrderId: id }, actorType: "USER", actorId: user.id });
        return ok(updated);
      }

      case "cancel": {
        assertWoTransition("CANCELLED", from, WO_TRANSITIONS);
        const updated = await db.workOrder.update({
          where: { id }, data: { status: "CANCELLED" }, include: WO_DETAIL_INCLUDE,
        });
        // PM §74 — cancelling a PM work order cancels the occurrence (never
        // counted as completed; compliance excludes it on both sides).
        if (updated.pmTaskId) {
          await db.pmTask.updateMany({
            where: { id: updated.pmTaskId, status: { in: ["SCHEDULED", "OVERDUE", "IN_PROGRESS"] } },
            data: { status: "CANCELLED" },
          });
          await audit({ actorId: user.id, actorEmail: user.email, action: "PM_CANCELLED", resourceType: "PM_TASK", resourceId: updated.pmTaskId, metadata: { workOrderCode: code, reason: body.note ?? "" } });
        }
        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_CANCELLED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code, fromStatus: from } });
        if (wo.technician?.user?.id && wo.technician.user.id !== user.id) {
          await notify({ userId: wo.technician.user.id, title: "Work order cancelled", message: `Work order ${code} was cancelled.`, type: "WARNING", resourceType: "WORK_ORDER", resourceId: id });
        }
        await emit({ type: EVENT_TYPES.WORK_ORDER_CANCELLED, resourceType: "WORK_ORDER", resourceId: id, payload: { code, workOrderId: id }, actorType: "USER", actorId: user.id });
        return ok(updated);
      }

      default:
        throw Errors.badRequest("Unknown action.");
    }
  },
  { permission: PERMISSIONS.work_orders_read }
);
