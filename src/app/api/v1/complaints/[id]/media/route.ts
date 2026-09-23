// MOHD.HMS ENTERPRISE — Complaint photo/video evidence (§14).
// GET  /api/v1/complaints/[id]/media — metadata list (bytes via …/[mediaId]/file).
// POST /api/v1/complaints/[id]/media — multipart upload (field: file, phase, caption?).
//   Allowed: assigned technician, complaints_update staff, or the owning customer
//   (portal users may attach supporting evidence). Files live in MinIO under
//   complaints/{id}/media/ (private bucket — never browser-direct); PostgreSQL
//   stores the metadata reference only. Validation by magic bytes: images
//   jpeg/png/webp ≤ 15 MB, videos mp4/webm ≤ 50 MB. phase = BEFORE|DURING|AFTER.
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import { assertViewComplaint, technicianProfileIdFor } from "../../_lib";

const MEDIA_PHASES = ["BEFORE", "DURING", "AFTER"] as const;

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

type SniffedMedia = { mime: string; ext: string; kind: "image" | "video" };

/** Magic-byte sniffer (identical contract to the work-order photo route). */
function sniffMediaType(buf: Buffer): SniffedMedia | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg", kind: "image" };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: "image/png", ext: "png", kind: "image" };
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp", kind: "image" };
  if (buf.toString("ascii", 4, 8) === "ftyp") return { mime: "video/mp4", ext: "mp4", kind: "video" };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: "video/webm", ext: "webm", kind: "video" };
  return null;
}

function sanitizeFilename(raw: string): string {
  const base = (raw.split(/[/\\]/).pop() ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (base || "upload").slice(0, 200);
}

// ── GET — media list (metadata only; bytes via …/[mediaId]/file) ─────────────

export const GET = withId(
  async (id, { user }) => {
    const complaint = await db.complaint.findUnique({
      where: { id },
      select: { id: true, customerId: true, createdById: true, assignedTechnicianId: true, code: true },
    });
    if (!complaint) throw Errors.notFound("Complaint not found.");
    const profileId = user.role === "TECHNICIAN" ? await technicianProfileIdFor(user.id) : null;
    assertViewComplaint(user, complaint, profileId);
    const media = await db.document.findMany({
      where: { resourceType: "COMPLAINT", resourceId: id, category: "COMPLAINT" },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, mimeType: true, sizeBytes: true, label: true, uploadedById: true, createdAt: true },
    });
    return ok(media);
  },
  PERMISSIONS.complaints_read
);

// ── POST — multipart upload (one file per request) ───────────────────────────

export const POST = withId(
  async (id, { req, user }) => {
    const complaint = await db.complaint.findUnique({
      where: { id },
      select: { id: true, code: true, status: true, customerId: true, createdById: true, assignedTechnicianId: true, customer: { select: { portalUser: { select: { id: true } } } } },
    });
    if (!complaint) throw Errors.notFound("Complaint not found.");
    if (["CLOSED", "CANCELLED"].includes(complaint.status)) {
      throw Errors.invalidTransition("This complaint is closed — media can no longer be added.");
    }

    const profileId = user.role === "TECHNICIAN" ? await technicianProfileIdFor(user.id) : null;
    assertViewComplaint(user, complaint, profileId);
    const isAssignedTech = !!profileId && complaint.assignedTechnicianId === profileId;
    const isUpdater = roleCan(user.role, PERMISSIONS.complaints_update);
    const isPortalOwner = user.role === "CUSTOMER" && complaint.customer.portalUser?.id === user.id;
    if (!isAssignedTech && !isUpdater && !isPortalOwner) throw Errors.forbidden();

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw Errors.badRequest("Expected a multipart form upload.");
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) {
      throw Errors.badRequest("No file was uploaded (field name: file).");
    }
    const phaseRaw = form.get("phase");
    const phase = typeof phaseRaw === "string" && (MEDIA_PHASES as readonly string[]).includes(phaseRaw) ? phaseRaw : "DURING";
    const captionRaw = form.get("caption");
    const caption = typeof captionRaw === "string" ? captionRaw.trim().slice(0, 500) : "";

    const buf = Buffer.from(await file.arrayBuffer());
    const sniffed = sniffMediaType(buf);
    if (!sniffed) {
      throw Errors.badRequest("Unsupported file type. Upload a JPEG, PNG or WebP image, or an MP4/WebM video.");
    }
    const maxBytes = sniffed.kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
    if (buf.length > maxBytes) {
      throw Errors.badRequest(
        sniffed.kind === "image"
          ? "Image is too large. Maximum allowed size is 15 MB."
          : "Video is too large. Maximum allowed size is 50 MB."
      );
    }

    const key = `complaints/${complaint.id}/media/${randomUUID()}.${sniffed.ext}`;
    await storage.put(key, buf, sniffed.mime);

    const safeName = sanitizeFilename(file.name);
    const doc = await db.document.create({
      data: {
        name: safeName,
        safeName,
        mimeType: sniffed.mime,
        sizeBytes: buf.length,
        storagePath: key,
        category: "COMPLAINT",
        resourceType: "COMPLAINT",
        resourceId: complaint.id,
        label: phase,
        uploadedById: user.id,
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "COMPLAINT_MEDIA_UPLOADED",
      resourceType: "DOCUMENT",
      resourceId: doc.id,
      metadata: { complaintCode: complaint.code, phase, caption, sizeBytes: buf.length },
    });

    return ok({ ...doc, caption: caption || null }, 201);
  },
  PERMISSIONS.complaints_read
);