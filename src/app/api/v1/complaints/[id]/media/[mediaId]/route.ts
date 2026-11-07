// MOHD.HMS ENTERPRISE — Complaint media immutability (§6/§11/§15).
// DELETE /api/v1/complaints/[id]/media/[mediaId]
// Complaint evidence is append-only: once a photo/video has been submitted it
// can never be replaced, edited, overwritten or deleted through ordinary
// interfaces or APIs. A correction is appended as a NEW file, never a mutation
// of the original record — so this endpoint refuses every attempt (audited), and
// the stored bytes + metadata row survive untouched.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
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

      // §6/§16 — complaint evidence is append-only and immutable, from creation
      // onwards (not merely after closure). A correction is a NEW append, never a
      // delete/replace. The attempt itself is audited so it is never silent.
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "COMPLAINT_MEDIA_DELETE_BLOCKED",
        resourceType: "DOCUMENT",
        resourceId: doc.id,
        metadata: {
          complaintCode: complaint.code,
          complaintId: complaint.id,
          fileName: doc.safeName,
          storagePath: doc.storagePath,
          phase: doc.label,
        },
      });
      throw Errors.conflict(
        "Complaint evidence is immutable and cannot be deleted or replaced. Add a corrected file instead."
      );
    },
    { auth: true, permission: PERMISSIONS.complaints_read }
  )(req as NextRequest) as Promise<NextResponse>;
};
