// MOHD.HMS ENTERPRISE — Complaint workflow transitions (server-side enforced).
// assign → accept/start → complete → confirm → close; cancel from open states.
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { COMPLAINT_TRANSITIONS, PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { COMPLAINT_DETAIL_INCLUDE, assertViewComplaint, technicianProfileIdFor } from "../../_lib";

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
        const tech = await db.technicianProfile.findUnique({ where: { id: body.technicianId }, include: { user: { select: { id: true, name: true } } } });
        if (!tech) throw Errors.badRequest("Technician profile not found.");

        const updated = await db.complaint.update({
          where: { id },
          data: { status: "ASSIGNED", assignedTechnicianId: tech.id, assignedAt: now },
          include: COMPLAINT_DETAIL_INCLUDE,
        });
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

        const updated = await db.complaint.update({
          where: { id },
          data: { status: "IN_PROGRESS", acceptedAt: complaint.acceptedAt ?? now, startedAt: now },
          include: COMPLAINT_DETAIL_INCLUDE,
        });
        await addHistory(id, from, "IN_PROGRESS", user.id, body.note ?? "Work started");
        await audit({
          actorId: user.id, actorEmail: user.email, action: "COMPLAINT_ACCEPTED",
          resourceType: "COMPLAINT", resourceId: id, metadata: { code },
        });
        await notifyRole("SUPERVISOR", {
          title: "Complaint in progress", message: `${code} is now in progress (${user.name}).`,
          type: "INFO", resourceType: "COMPLAINT", resourceId: id,
        });
        return ok(updated);
      }

      case "complete": {
        const isAssignedTech = !!profileId && complaint.assignedTechnicianId === profileId;
        if (!isAssignedTech && !roleCan(user.role, PERMISSIONS.complaints_update)) throw Errors.forbidden();
        assertTransition("COMPLETED", from);

        const updated = await db.complaint.update({
          where: { id },
          data: {
            status: "COMPLETED",
            completedAt: now,
            ...(body.note ? { resolutionNotes: body.note } : {}),
          },
          include: COMPLAINT_DETAIL_INCLUDE,
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
        return ok(updated);
      }

      case "confirm": {
        const isPortalOwner = user.role === "CUSTOMER" && !!user.customerId && complaint.customerId === user.customerId;
        const staffUpdater = roleCan(user.role, PERMISSIONS.complaints_update);
        if (!isPortalOwner && !staffUpdater) throw Errors.forbidden();
        assertTransition("CONFIRMED", from);

        const updated = await db.complaint.update({
          where: { id },
          data: {
            status: "CONFIRMED",
            confirmedAt: now,
            ...(body.note ? { customerFeedback: body.note } : {}),
          },
          include: COMPLAINT_DETAIL_INCLUDE,
        });
        await addHistory(id, from, "CONFIRMED", user.id, body.note ?? "Customer confirmed resolution");
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
            title: "Complaint confirmed", message: `Complaint ${code} confirmed, ready for invoicing.`,
            type: "INFO", resourceType: "COMPLAINT", resourceId: id,
          }),
        ]);
        return ok(updated);
      }

      case "close": {
        if (!roleCan(user.role, PERMISSIONS.complaints_close)) throw Errors.forbidden();
        assertTransition("CLOSED", from);

        const updated = await db.complaint.update({
          where: { id },
          data: { status: "CLOSED", closedAt: now },
          include: COMPLAINT_DETAIL_INCLUDE,
        });
        await addHistory(id, from, "CLOSED", user.id, body.note ?? "Complaint closed");
        await audit({
          actorId: user.id, actorEmail: user.email, action: "COMPLAINT_CLOSED",
          resourceType: "COMPLAINT", resourceId: id, metadata: { code },
        });
        return ok(updated);
      }

      case "cancel": {
        if (!roleCan(user.role, PERMISSIONS.complaints_assign)) throw Errors.forbidden();
        assertTransition("CANCELLED", from);

        const updated = await db.complaint.update({
          where: { id },
          data: { status: "CANCELLED" },
          include: COMPLAINT_DETAIL_INCLUDE,
        });
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
