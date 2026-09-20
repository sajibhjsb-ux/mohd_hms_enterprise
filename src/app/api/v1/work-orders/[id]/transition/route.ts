// MOHD.HMS ENTERPRISE — Work order workflow transitions (server-side enforced).
// accept | start | hold | resume | complete | cancel
// On completion: recompute totals and deduct inventoried material stock inside a
// single $transaction (idempotent — the from-status guard rejects double runs).
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { WO_TRANSITIONS, PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { WO_DETAIL_INCLUDE, assertViewWorkOrder, isAssignedTechnician, assertWoTransition } from "../../_lib";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { dedupeSubmission } from "@/lib/hms/workflows/idempotency";
import { computeNextDue } from "@/lib/hms/pm/schedule";

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
          const checklist = await tx.workOrderChecklistItem.findMany({
            where: { workOrderId: id },
            select: { label: true, done: true, required: true, responseType: true, response: true },
          });
          const pending = checklist.filter((c) => !c.done || (c.required && c.responseType !== "CHECKBOX" && c.response.trim() === ""));
          if (pending.length > 0) {
            throw Errors.invalidTransition(
              `Cannot complete: ${pending.length} checklist item(s) still open (${pending.slice(0, 3).map((c) => c.label).join(", ")}${pending.length > 3 ? "…" : ""}).`
            );
          }

          // Stock deduction for inventoried materials (once — from-status guard above)
          const lowStock: { id: string }[] = [];
          for (const m of current.materials) {
            if (!m.inventoryItemId) continue;
            const item = await tx.inventoryItem.findUnique({ where: { id: m.inventoryItemId }, select: { id: true, stockQty: true, minStockQty: true } });
            if (!item) continue;
            const balanceAfter = item.stockQty - m.quantity;
            await tx.inventoryItem.update({ where: { id: item.id }, data: { stockQty: balanceAfter } });
            await tx.stockMovement.create({
              data: {
                itemId: item.id, type: "ISSUE", quantity: -m.quantity, balanceAfter,
                referenceType: "WORK_ORDER", referenceId: current.id, note: current.code, createdById: user.id,
              },
            });
            // §17 — flag items that dropped to/below minimum after this issue.
            if (balanceAfter <= item.minStockQty) lowStock.push({ id: item.id });
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
          return { updated: row, lowStockItems: lowStock };
        });

        await audit({ actorId: user.id, actorEmail: user.email, action: "WORK_ORDER_COMPLETED", resourceType: "WORK_ORDER", resourceId: id, metadata: { code, totalCents: updated.totalCents } });
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
