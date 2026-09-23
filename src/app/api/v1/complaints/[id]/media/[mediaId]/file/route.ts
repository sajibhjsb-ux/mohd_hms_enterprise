// MOHD.HMS ENTERPRISE — Complaint media file stream (§10/§13/§14).
// GET /api/v1/complaints/[id]/media/[mediaId]/file
// Private object-store serving: authenticated + RBAC-scoped (complaints_read +
// business scope via assertViewComplaint — no URL/ID guessing, no IDOR).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage } from "@/lib/hms/storage";
import { assertViewComplaint, technicianProfileIdFor } from "../../../../_lib";

export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string; mediaId: string }> }) => {
  const { id, mediaId } = await ctx.params;
  return handler(
    async ({ req, user }) => {
      // §3 — explicit download action: ?download=1 forces attachment disposition.
      const forceDownload = new URL(req.url).searchParams.get("download") === "1";
      const complaint = await db.complaint.findUnique({
        where: { id },
        select: { id: true, customerId: true, createdById: true, assignedTechnicianId: true },
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
      const file = await storage.get(doc.storagePath);
      if (!file) throw Errors.notFound("Media file not found.");

      // Images/videos preview inline (play/pause/seek in <video>); ?download=1
      // or unknown binaries download as attachments.
      const inline = !forceDownload && (file.contentType.startsWith("image/") || file.contentType.startsWith("video/"));
      return new NextResponse(Buffer.from(file.buffer), {
        status: 200,
        headers: {
          "Content-Type": file.contentType,
          "Content-Length": String(file.buffer.length),
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${doc.safeName.replace(/["\\]/g, "")}"`,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
          "Accept-Ranges": "none",
        },
      });
    },
    { auth: true, permission: PERMISSIONS.complaints_read }
  )(req as NextRequest);
};
