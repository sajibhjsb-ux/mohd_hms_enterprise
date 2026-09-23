// MOHD.HMS ENTERPRISE — Work order workflow transitions (server-side enforced).
// accept | start | hold | resume | complete | cancel
// On completion: recompute totals and deduct inventoried material stock inside a
// single $transaction (idempotent — the from-status guard rejects double runs).
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { WO_TRANSITIONS, PERMISSIONS } from "@/lib/hms/constants";
import { automationNumber } from "@/lib/hms/workflows/settings";
import type { SessionUser } from "@/lib/hms/auth";
import { WO_DETAIL_INCLUDE, assertViewWorkOrder, isAssignedTechnician, assertWoTransition } from "../../_lib";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { emit } from "@/lib/hms/workflows/bus";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";
import { computeNextDue } from "@/lib/hms/pm/schedule";
import { applyStockMovement, consumeReservation } from "@/lib/hms/inventory";

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
  action: z.enum(["accept", "start", "hold", "resume", "complete", "cancel"]),
  note: z.string().max(2000).optional(),
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
        await notifyRole("SUPERVISOR", { title: "Work order accepted", message: `${code} accepted by ${user.name}.`, type: "INFO", resourceType: "WORK_ORDER", resourceId: id });
        return ok(updated);
      }

      case "start": {
        assertWoTransition("IN_PROGRESS", from, WO_TRANSITIONS);

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
          if (photoCount < beforePhotosMin) {
            missing.push(`Before-work photo evidence (${photoCount}/${beforePhotosMin} required)`);
          }
        }

        const checklist = await db.workOrderChecklistItem.findMany({
          where: { workOrderId: id },
          select: { label: true, done: true, required: true, responseType: true, response: true },
        });
        const unanswered = checklist.filter((c) => !c.done || (c.required && c.responseType !== "CHECKBOX" && c.response.trim() === ""));
        // §16/§18 — a pre-work checklist must EXIST, not merely be empty-complete:
        // a work order with zero checklist items has no verifiable pre-work
        // evidence, so Start stays blocked (AI/template/manual paths remain available).
        if (checklist.length === 0) {
          missing.push("No pre-work checklist attached — generate one with AI, use a template, or add items manually");
        } else if (unanswered.length > 0) {
          missing.push(`Mandatory checklist result: ${unanswered[0].label}${unanswered.length > 1 ? ` (+${unanswered.length - 1} more)` : ""}`);
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
              completed: checklist.length > 0 && unanswered.length === 0,
              requiredTotal: checklist.filter((c) => c.required).length,
              requiredDone: checklist.filter((c) => c.required && c.done && (c.responseType === "CHECKBOX" || c.response.trim() !== "")).length,
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
          // Cascade: a linked complaint still waiting moves into progress with its own history row.
          if (row.complaintId) {
            const complaint = await tx.complaint.findUnique({ where: { id: row.complaintId }, select: { id: true, status: true, code: true } });
            if (complaint && complaint.status === "ASSIGNED") {
              await tx.complaint.update({ where: { id: complaint.id }, data: { status: "IN_PROGRESS", acceptedAt: now, startedAt: now } });
              await tx.complaintStatusHistory.create({
                data: { complaintId: complaint.id, fromStatus: "ASSIGNED", toStatus: "IN_PROGRESS", changedById: user.id, note: `Work order ${code} started` },
              });
            }
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
        await notifyRole("SUPERVISOR", { title: "Work order started", message: `${code} started by ${user.name}.`, type: "INFO", resourceType: "WORK_ORDER", resourceId: id });
        return ok(updated);
      }

      case "hold": {
        assertWoTransition("ON_HOLD", from, WO_TRANSITIONS);
        const updated = await db.workOrder.update({
          where: { id }, data: { status: "ON_HOLD", ...(body.note ? { notes: body.note } : {}) }, include: WO_DETAIL_INCLUDE,
        });
        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_ON_HOLD", resourceType: "WORK_ORDER", resourceId: id, metadata: { code, note: body.note ?? "" } });
        await notifyRole("SUPERVISOR", { title: "Work order on hold", message: `${code} put on hold by ${user.name}.${body.note ? ` Note: ${body.note}` : ""}`, type: "WARNING", resourceType: "WORK_ORDER", resourceId: id });
        return ok(updated);
      }

      case "resume": {
        assertWoTransition("IN_PROGRESS", from, WO_TRANSITIONS);
        const updated = await db.workOrder.update({
          where: { id }, data: { status: "IN_PROGRESS" }, include: WO_DETAIL_INCLUDE,
        });
        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_RESUMED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code } });
        return ok(updated);
      }

      case "complete": {
        assertWoTransition("COMPLETED", from, WO_TRANSITIONS);
        // Holder object — TS control-flow can't track assignments made inside the
        // transaction callback, so the completed instance rides out in a ref.
        const ref: { completedInstance: { id: string; code: string } | null; autoClosedComplaint: { id: string; code: string; fromStatus: string } | null } = { completedInstance: null, autoClosedComplaint: null };
        const { updated, lowStockItems } = await db.$transaction(async (tx) => {
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
          const checklist = await tx.workOrderChecklistItem.findMany({
            where: { workOrderId: id },
            select: { label: true, done: true, required: true, responseType: true, response: true, notes: true, requiresPhoto: true, failRequiresFinding: true },
          });
          const pending = checklist.filter((c) => !c.done || (c.required && c.responseType !== "CHECKBOX" && c.response.trim() === ""));
          const failedNoNote = checklist.filter((c) => c.failRequiresFinding && ["FAIL", "NO"].includes(c.response.trim().toUpperCase()) && c.notes.trim() === "");
          const photoRequiredItems = checklist.filter((c) => c.requiresPhoto);
          let checklistPhotos = 0;
          if (photoRequiredItems.length > 0) {
            checklistPhotos = await tx.document.count({
              where: { resourceType: "WORK_ORDER", resourceId: id, category: "WORK_ORDER" },
            });
          }
          const missing: string[] = [];
          if (pending.length > 0) missing.push(...pending.slice(0, 3).map((c) => `Task result: ${c.label}`));
          if (failedNoNote.length > 0) missing.push(...failedNoNote.slice(0, 3).map((c) => `Note for failed task: ${c.label}`));
          if (photoRequiredItems.length > checklistPhotos) {
            missing.push(`Checklist photo evidence (${checklistPhotos}/${photoRequiredItems.length} uploaded)`);
          }
          if (missing.length > 0) {
            throw Errors.invalidTransition(
              `Cannot complete work order. Missing: ${missing.slice(0, 5).join("; ")}${missing.length > 5 ? "…" : ""}.`
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

          // Transactional outbox (§5): completion event commits with the stock
          // deduction — the auto-invoice workflow can never be lost or orphaned.
          await tx.domainEvent.create({
            data: {
              type: EVENT_TYPES.WORK_ORDER_COMPLETED, resourceType: "WORK_ORDER", resourceId: id,
              payload: JSON.stringify({ code: current.code, totalCents: labourTotalCents + materialsTotalCents }),
              actorType: "USER", actorId: user.id,
            },
          });
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

          // PM §2/§25/§31 — completing a PM work order closes its occurrence and
          // triggers the next maintenance cycle (backend-authoritative, same tx).
          if (current.pmTaskId) {
            const task = await tx.pmTask.findUnique({
              where: { id: current.pmTaskId },
              include: { plan: true },
            });
            if (task && task.status !== "COMPLETED" && task.status !== "SKIPPED" && task.status !== "CANCELLED") {
              await tx.pmTask.update({
                where: { id: task.id },
                data: { status: "COMPLETED", completedAt: now },
              });
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
          // Checklist engine — the work order's checklist instance completes WITH
          // the work order (one lifecycle, same transaction — §36/§51).
          const inst = await tx.checklistInstance.findUnique({ where: { workOrderId: id }, select: { id: true, code: true, status: true } });
          if (inst && inst.status === "ACTIVE") {
            await tx.checklistInstance.update({ where: { id: inst.id }, data: { status: "COMPLETED", completedAt: now } });
            ref.completedInstance = { id: inst.id, code: inst.code };
          }

          // §15 — a COMPLETED work order auto-closes its source complaint
          // (backend business rule, same transaction — no partial states). Any
          // non-terminal complaint state collapses to CLOSED: the linked work
          // is settled, so the complaint lifecycle is over. No INCOMPLETE final
          // status exists in this work-order machine (§16 n/a).
          if (current.complaintId) {
            const complaint = await tx.complaint.findUnique({
              where: { id: current.complaintId },
              select: { id: true, code: true, status: true, completedAt: true },
            });
            if (complaint && !["CLOSED", "CANCELLED"].includes(complaint.status)) {
              await tx.complaint.update({
                where: { id: complaint.id },
                data: { status: "CLOSED", closedAt: now, completedAt: complaint.completedAt ?? now },
              });
              await tx.complaintStatusHistory.create({
                data: {
                  complaintId: complaint.id,
                  fromStatus: complaint.status,
                  toStatus: "CLOSED",
                  changedById: user.id,
                  note: `Complaint automatically closed after linked Work Order ${current.code} was completed.`,
                },
              });
              await tx.domainEvent.create({
                data: {
                  type: EVENT_TYPES.COMPLAINT_CLOSED, resourceType: "COMPLAINT", resourceId: complaint.id,
                  payload: JSON.stringify({ code: complaint.code, reason: "WORK_ORDER_COMPLETED", workOrderCode: current.code }),
                  actorType: "USER", actorId: user.id,
                },
              });
              ref.autoClosedComplaint = { id: complaint.id, code: complaint.code, fromStatus: complaint.status };
            }
          }
          return { updated: row, lowStockItems: lowStock };
        });

        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_COMPLETED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code, totalCents: updated.totalCents } });
        if (ref.autoClosedComplaint) {
          // §15 — audit trail on the COMPLAINT so the auto-close shows on its
          // timeline (WorkflowTimeline reads COMPLAINT audit rows).
          await audit({ actorId: user.id, actorEmail: user.email, action: "COMPLAINT_AUTO_CLOSED", resourceType: "COMPLAINT", resourceId: ref.autoClosedComplaint.id, metadata: { code: ref.autoClosedComplaint.code, reason: "Linked work order completed", workOrderCode: code, fromStatus: ref.autoClosedComplaint.fromStatus } });
        }
        if (ref.completedInstance) {
          await audit({ actorId: user.id, actorEmail: user.email, action: "CHECKLIST_COMPLETED", resourceType: "CHECKLIST_INSTANCE", resourceId: ref.completedInstance.id, metadata: { code: ref.completedInstance.code, workOrderCode: code } });
          await emit({ type: EVENT_TYPES.CHECKLIST_COMPLETED, resourceType: "CHECKLIST_INSTANCE", resourceId: ref.completedInstance.id, payload: { code: ref.completedInstance.code, workOrderCode: code }, actorType: "USER", actorId: user.id });
        }
        await notifyRole("SUPERVISOR", { title: "Work order completed", message: `${code} completed by ${user.name}.`, type: "SUCCESS", resourceType: "WORK_ORDER", resourceId: id });
        if (portalUserId) {
          await notify({ userId: portalUserId, title: "Work order completed", message: `Work order ${code} for your site has been completed.`, type: "SUCCESS", resourceType: "WORK_ORDER", resourceId: id });
        }
        // PM §72 — PM completion audit + supervisor notification (occurrence closed,
        // next cycle already computed inside the transaction above).
        if (updated.pmTaskId) {
          await audit({ actorId: user.id, actorEmail: user.email, action: "PM_COMPLETED", resourceType: "PM_TASK", resourceId: updated.pmTaskId, metadata: { taskCode: updated.pmTask?.code ?? null, workOrderCode: code } });
          await notifyRole("SUPERVISOR", { title: "PM completed", message: `PM occurrence ${updated.pmTask?.code ?? ""} (${code}) completed by ${user.name}. Review when ready.`, type: "SUCCESS", resourceType: "PM_TASK", resourceId: updated.pmTaskId });
        }
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
        return ok(updated);
      }

      default:
        throw Errors.badRequest("Unknown action.");
    }
  },
  { permission: PERMISSIONS.work_orders_read }
);
