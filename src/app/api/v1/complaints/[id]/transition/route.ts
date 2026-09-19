// MOHD.HMS ENTERPRISE — Complaint workflow transitions (server-side enforced).
// assign → accept/start → complete → confirm → close; cancel from open states.
// §9 state machine (COMPLAINT_TRANSITIONS), §56 optimistic concurrency
// (status-guarded updateMany), §4/§5 transactional outbox on the invoicing path.
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { COMPLAINT_TRANSITIONS, PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { COMPLAINT_DETAIL_INCLUDE, assertViewComplaint, technicianProfileIdFor } from "../../_lib";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

const transitionSchema = z.object({
  action: z.enum(["assign", "accept", "start", "complete", "confirm", "close", "cancel"]),
  technicianId: z.string().min(1).optional(),
  note: z.string().max(2000).optional(),
});

function assertTransition(to: string, from: string): void {
  const allowed = COMPLAINT_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) throw Errors.invalidTransition(`${from} → ${to} is not allowed`);
}

async function addHistory(complaintId: string, fromStatus: string, toStatus: string, changedById: string, note: string) {
  await db.complaintStatusHistory.create({ data: { complaintId, fromStatus, toStatus, changedById, note } });
}

/** §56 — status-guarded update; a concurrent transition yields 409, never drift. */
async function guardedUpdate(id: string, from: string, data: Record<string, unknown>) {
  const res = await db.complaint.updateMany({ where: { id, status: from }, data });
  if (res.count === 0) {
    throw Errors.conflict("This complaint was just updated by someone else. Reload the page and try again.");
  }
  return db.complaint.findUnique({ where: { id }, include: COMPLAINT_DETAIL_INCLUDE });
}

export const POST = withId(
  async (id, { req, user }) => {
    const body = await parseBody(req, transitionSchema);
    const complaint = await db.complaint.findUnique({
      where: { id },
      include: COMPLAINT_DETAIL_INCLUDE,
    });
    if (!complaint) throw Errors.notFound("Complaint not found.");

    const profileId = user.role === "TECHNICIAN" ? await technicianProfileIdFor(user.id) : null;
    assertViewComplaint(user, complaint, profileId);

    const from = complaint.status;
    const now = new Date();
    const portalUserId = complaint.customer.portalUser?.id ?? null;
    const code = complaint.code;

    switch (body.action) {
      case "assign": {
        if (!roleCan(user.role, PERMISSIONS.complaints_assign)) throw Errors.forbidden();
        assertTransition("ASSIGNED", from);
        if (!body.technicianId) throw Errors.badRequest("technicianId is required to assign a complaint.");
        const tech = await db.technicianProfile.findUnique({ where: { id: body.technicianId }, include: { user: { select: { id: true, name: true, status: true } } } });
        if (!tech) throw Errors.badRequest("Technician profile not found.");
        // §11 — assignment is only valid for an active technician account.
        if (tech.user.status !== "ACTIVE") throw Errors.badRequest("Technician is not active.");

        const updated = await guardedUpdate(id, from, { status: "ASSIGNED", assignedTechnicianId: tech.id, assignedAt: now });
        await addHistory(id, from, "ASSIGNED", user.id, body.note ?? `Assigned to ${tech.user.name}`);
        await audit({
          actorId: user.id, actorEmail: user.email, action: "COMPLAINT_ASSIGNED",
          resourceType: "COMPLAINT", resourceId: id, metadata: { code, technicianId: tech.id, technician: tech.user.name },
        });
        await notify({
          userId: tech.userId, title: "New complaint assigned",
          message: `You have been assigned complaint ${code}: ${complaint.title}`,
          type: "INFO", resourceType: "COMPLAINT", resourceId: id,
        });
        if (portalUserId) {
          await notify({
            userId: portalUserId, title: "Complaint assigned",
            message: `Your complaint ${code} has been assigned to a technician.`,
            type: "INFO", resourceType: "COMPLAINT", resourceId: id,
          });
        }
        // Outbox: assignment event (escalation engine keys off it) + queued email.
        await emit({ type: EVENT_TYPES.COMPLAINT_ASSIGNED, resourceType: "COMPLAINT", resourceId: id, payload: { code, technicianId: tech.id }, actorType: "USER", actorId: user.id });
        await emit({ type: EVENT_TYPES.EMAIL_SEND, resourceType: "COMPLAINT", resourceId: id, payload: { userId: tech.userId, title: "New complaint assigned", message: `You have been assigned complaint ${code}: ${complaint.title}` }, actorType: "USER", actorId: user.id });
        return ok(updated);
      }

      case "accept":
      case "start": {
        // Only the assigned technician may accept/start (start is an alias; no-op if already running).
        if (complaint.assignedTechnicianId !== profileId || !profileId) {
          throw Errors.forbidden("Only the assigned technician can start work on this complaint.");
        }
        if (from === "IN_PROGRESS") return ok(complaint); // idempotent no-op
        assertTransition("IN_PROGRESS", from);

        const updated = await guardedUpdate(id, from, { status: "IN_PROGRESS", acceptedAt: complaint.acceptedAt ?? now, startedAt: now });
        await addHistory(id, from, "IN_PROGRESS", user.id, body.note ?? "Work started");
        await audit({
          actorId: user.id, actorEmail: user.email, action: body.action === "accept" ? "COMPLAINT_ACCEPTED" : "COMPLAINT_STARTED",
          resourceType: "COMPLAINT", resourceId: id, metadata: { code },
        });
        await notifyRole("SUPERVISOR", {
          title: "Complaint in progress", message: `${code} is now in progress (${user.name}).`,
          type: "INFO", resourceType: "COMPLAINT", resourceId: id,
        });
        // Outbox: acceptance/start event — auto work order creation keys off it (§13).
        await emit({
          type: body.action === "accept" ? EVENT_TYPES.COMPLAINT_ACCEPTED : EVENT_TYPES.COMPLAINT_STARTED,
          resourceType: "COMPLAINT", resourceId: id, payload: { code }, actorType: "USER", actorId: user.id,
        });
        return ok(updated);
      }

      case "complete": {
        const isAssignedTech = !!profileId && complaint.assignedTechnicianId === profileId;
        if (!isAssignedTech && !roleCan(user.role, PERMISSIONS.complaints_update)) throw Errors.forbidden();
        assertTransition("COMPLETED", from);

        const updated = await guardedUpdate(id, from, {
          status: "COMPLETED",
          completedAt: now,
          ...(body.note ? { resolutionNotes: body.note } : {}),
        });
        await addHistory(id, from, "COMPLETED", user.id, body.note ?? "Resolution recorded");
        await audit({
          actorId: user.id, actorEmail: user.email, action: "COMPLAINT_COMPLETED",
          resourceType: "COMPLAINT", resourceId: id, metadata: { code },
        });
        if (portalUserId) {
          await notify({
            userId: portalUserId, title: "Complaint resolved",
            message: `Your complaint ${code} has been resolved, please confirm.`,
            type: "SUCCESS", resourceType: "COMPLAINT", resourceId: id,
          });
        }
        await notifyRole("SUPERVISOR", {
          title: "Complaint completed", message: `${code} marked completed by ${user.name}, awaiting customer confirmation.`,
          type: "INFO", resourceType: "COMPLAINT", resourceId: id,
        });
        await emit({ type: EVENT_TYPES.COMPLAINT_COMPLETED, resourceType: "COMPLAINT", resourceId: id, payload: { code }, actorType: "USER", actorId: user.id });
        return ok(updated);
      }

      case "confirm": {
        const isPortalOwner = user.role === "CUSTOMER" && !!user.customerId && complaint.customerId === user.customerId;
        const staffUpdater = roleCan(user.role, PERMISSIONS.complaints_update);
        if (!isPortalOwner && !staffUpdater) throw Errors.forbidden();
        assertTransition("CONFIRMED", from);

        // §4/§5 transactional outbox: the status change, history and the outbox
        // event that auto-creates the draft invoice commit atomically.
        const updated = await db.$transaction(async (tx) => {
          const res = await tx.complaint.updateMany({
            where: { id, status: from },
            data: { status: "CONFIRMED", confirmedAt: now, ...(body.note ? { customerFeedback: body.note } : {}) },
          });
          if (res.count === 0) throw Errors.conflict("This complaint was just updated by someone else. Reload the page and try again.");
          await tx.complaintStatusHistory.create({ data: { complaintId: id, fromStatus: from, toStatus: "CONFIRMED", changedById: user.id, note: body.note ?? "Customer confirmed resolution" } });
          await tx.domainEvent.create({
            data: {
              type: EVENT_TYPES.COMPLAINT_CONFIRMED, resourceType: "COMPLAINT", resourceId: id,
              payload: JSON.stringify({ code }), actorType: "USER", actorId: user.id,
            },
          });
          return tx.complaint.findUnique({ where: { id }, include: COMPLAINT_DETAIL_INCLUDE });
        });
        await audit({
          actorId: user.id, actorEmail: user.email, action: "COMPLAINT_CONFIRMED",
          resourceType: "COMPLAINT", resourceId: id, metadata: { code, by: user.role },
        });
        await Promise.all([
          notifyRole("ADMIN", {
            title: "Complaint confirmed", message: `Complaint ${code} confirmed, ready for invoicing.`,
            type: "INFO", resourceType: "COMPLAINT", resourceId: id,
          }),
          notifyRole("FINANCE", {
            title: "Complaint confirmed", message: `Complaint ${code} confirmed, a draft invoice will be generated automatically for review.`,
            type: "INFO", resourceType: "COMPLAINT", resourceId: id,
          }),
        ]);
        return ok(updated);
      }

      case "close": {
        if (!roleCan(user.role, PERMISSIONS.complaints_close)) throw Errors.forbidden();
        assertTransition("CLOSED", from);

        const updated = await guardedUpdate(id, from, { status: "CLOSED", closedAt: now });
        await addHistory(id, from, "CLOSED", user.id, body.note ?? "Complaint closed");
        await audit({
          actorId: user.id, actorEmail: user.email, action: "COMPLAINT_CLOSED",
          resourceType: "COMPLAINT", resourceId: id, metadata: { code },
        });
        await emit({ type: EVENT_TYPES.COMPLAINT_CLOSED, resourceType: "COMPLAINT", resourceId: id, payload: { code }, actorType: "USER", actorId: user.id });
        return ok(updated);
      }

      case "cancel": {
        if (!roleCan(user.role, PERMISSIONS.complaints_assign)) throw Errors.forbidden();
        assertTransition("CANCELLED", from);

        const updated = await guardedUpdate(id, from, { status: "CANCELLED" });
        await addHistory(id, from, "CANCELLED", user.id, body.note ?? "Complaint cancelled");
        await audit({
          actorId: user.id, actorEmail: user.email, action: "COMPLAINT_CANCELLED",
          resourceType: "COMPLAINT", resourceId: id, metadata: { code, fromStatus: from },
        });
        if (complaint.assignedTechnician?.user?.id) {
          await notify({
            userId: complaint.assignedTechnician.user.id, title: "Complaint cancelled",
            message: `Complaint ${code} was cancelled.`, type: "WARNING", resourceType: "COMPLAINT", resourceId: id,
          });
        }
        if (portalUserId) {
          await notify({
            userId: portalUserId, title: "Complaint cancelled",
            message: `Your complaint ${code} was cancelled.`, type: "WARNING", resourceType: "COMPLAINT", resourceId: id,
          });
        }
        return ok(updated);
      }

      default:
        throw Errors.badRequest("Unknown action.");
    }
  },
  { permission: PERMISSIONS.complaints_read }
);
