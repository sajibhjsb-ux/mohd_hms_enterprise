// MOHD.HMS ENTERPRISE — Complaint media deletion (§11/§15).
// DELETE /api/v1/complaints/[id]/media/[mediaId]
// Evidence deletion is never silent: backend authorization (uploader themself
// or complaints_update staff — customers/technicians can only retract their OWN
// uploads), complaint-status freeze (CLOSED/CANCELLED evidence is immutable),
// object-store removal, metadata row removal, and a full audit trail (who,
// when, what file, which complaint).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import { assertViewComplaint, technicianProfileIdFor } from "../../../_lib";

export const DELETE = async (req: NextRequest, ctx: { params: Promise<{ id: string; mediaId: string }> }) => {
  const { id, mediaId } = await ctx.params;
  return handler(
    async ({ user }) => {
      const complaint = await db.complaint.findUnique({
        where: { id },
        select: { id: true, code: true, status: true, customerId: true, createdById: true, assignedTechnicianId: true },
      });
      if (!complaint) throw Errors.notFound("Complaint not found.");
      const profileId = user.role === "TECHNICIAN" ? await technicianProfileIdFor(user.id) : null;
      // 404 (not 403) for out-of-scope callers — existence stays hidden.
      try {
        assertViewComplaint(user, complaint, profileId);
      } catch {
        throw Errors.notFound("Media not found.");
      }

      const doc = await db.document.findFirst({
        where: { id: mediaId, resourceType: "COMPLAINT", resourceId: id, category: "COMPLAINT" },
      });
      if (!doc) throw Errors.notFound("Media not found.");

      // §16 — evidence freeze: a CLOSED/CANCELLED complaint's record is final.
      if (["CLOSED", "CANCELLED"].includes(complaint.status)) {
        throw Errors.invalidTransition("This complaint is closed — its evidence can no longer be changed.");
      }

      // §15 — only the uploader themself or complaints_update staff may delete;
      // nobody silently removes someone else's evidence otherwise.
      const isStaff = roleCan(user.role, PERMISSIONS.complaints_update);
      const isUploader = !!doc.uploadedById && doc.uploadedById === user.id;
      if (!isStaff && !isUploader) {
        throw Errors.forbidden("Only the uploader or authorized staff can delete this media.");
      }

      // Object store first, then the metadata row (a row without bytes must
      // never survive — the file route would surface "Media file not found").
      await storage.remove(doc.storagePath);
      await db.document.delete({ where: { id: doc.id } });

      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "COMPLAINT_MEDIA_DELETED",
        resourceType: "DOCUMENT",
        resourceId: doc.id,
        metadata: {
          complaintCode: complaint.code,
          complaintId: complaint.id,
          fileName: doc.safeName,
          storagePath: doc.storagePath,
          mimeType: doc.mimeType,
          sizeBytes: doc.sizeBytes,
          phase: doc.label,
        },
      });

      return ok({ id: doc.id, deleted: true });
    },
    { auth: true, permission: PERMISSIONS.complaints_read }
  )(req as NextRequest) as Promise<NextResponse>;
};
