// MOHD.HMS ENTERPRISE — PM occurrence photo evidence (PM §20).
// GET  /api/v1/pm/tasks/[id]/photos — list evidence rows (metadata only).
// POST /api/v1/pm/tasks/[id]/photos — multipart upload (field: file, phase).
//   pm_manage, or pm_execute when the caller IS the assigned technician's user.
// Files live in the private object store; bytes are served ONLY through the
// authenticated /api/v1/pm/photos/[id]/file route. Upload validation is by
// magic bytes — images jpeg/png/webp ≤ 15 MB, videos mp4/webm ≤ 50 MB.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS, PM_PHOTO_PHASES } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const CLOSED_STATUSES = ["COMPLETED", "SKIPPED", "CANCELLED", "FAILED"];
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

type SniffedMedia = { mime: string; ext: string; kind: "image" | "video" };

/** Local magic-byte sniffer (jpeg/png/webp images, mp4/webm videos) — §4 bytes are the truth. */
function sniffMediaType(buf: Buffer): SniffedMedia | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg", kind: "image" };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: "image/png", ext: "png", kind: "image" };
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp", kind: "image" };
  // MP4/MOV ISO-BMFF family: "....ftyp" at offset 4
  if (buf.toString("ascii", 4, 8) === "ftyp") return { mime: "video/mp4", ext: "mp4", kind: "video" };
  // WebM/Matroska EBML header
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: "video/webm", ext: "webm", kind: "video" };
  return null;
}

/** Strip any path component and control characters; client names never become keys. */
function sanitizeFilename(raw: string): string {
  const base = (raw.split(/[/\\]/).pop() ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (base || "upload").slice(0, 200);
}

// ── GET — evidence list (metadata only; bytes via /pm/photos/[id]/file) ─────

export const GET = withId(
  async (id, { user }) => {
    const task = await db.pmTask.findUnique({
      where: { id },
      select: { id: true, equipment: { select: { customerId: true } } },
    });
    if (!task) throw Errors.notFound("PM task not found.");
    // §44 defense-in-depth — customers only ever see their own equipment's evidence.
    if (user.role === "CUSTOMER" && task.equipment.customerId !== user.customerId) {
      throw Errors.forbidden();
    }
    const photos = await db.document.findMany({
      where: { resourceType: "PM_TASK", resourceId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, mimeType: true, sizeBytes: true, label: true, createdAt: true },
    });
    return ok(photos);
  },
  PERMISSIONS.pm_read
);

// ── POST — multipart upload (one file per request) ──────────────────────────

export const POST = withId(
  async (id, { req, user }) => {
    const task = await db.pmTask.findUnique({
      where: { id },
      include: { technician: { select: { userId: true } } },
    });
    if (!task) throw Errors.notFound("PM task not found.");

    // pm_manage, or pm_execute as the assigned technician's user — nobody else.
    const isManager = roleCan(user.role, PERMISSIONS.pm_manage);
    const isAssignedTech = roleCan(user.role, PERMISSIONS.pm_execute) && !!task.technician && task.technician.userId === user.id;
    if (!isManager && !isAssignedTech) throw Errors.forbidden();

    // Closed occurrences accept no new evidence unless a manager explicitly does.
    if (CLOSED_STATUSES.includes(task.status) && !isManager) {
      throw Errors.invalidTransition("This occurrence is closed — photos can no longer be added.");
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw Errors.badRequest("Expected a multipart form upload.");
    }
    const phaseRaw = form.get("phase");
    const phase = typeof phaseRaw === "string" && phaseRaw ? phaseRaw : "DURING";
    if (!(PM_PHOTO_PHASES as readonly string[]).includes(phase)) {
      throw Errors.badRequest(`Unknown photo phase. Use one of: ${PM_PHOTO_PHASES.join(", ")}.`);
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) {
      throw Errors.badRequest("No file was uploaded (field name: file).");
    }

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

    const key = `pm/${task.id}/${phase}/${randomUUID()}.${sniffed.ext}`;
    await storage.put(key, buf, sniffed.mime);

    const safeName = sanitizeFilename(file.name);
    const doc = await db.document.create({
      data: {
        name: safeName,
        safeName,
        mimeType: sniffed.mime,
        sizeBytes: buf.length,
        storagePath: key,
        category: "WORK_ORDER",
        resourceType: "PM_TASK",
        resourceId: task.id,
        label: phase,
        uploadedById: user.id,
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PM_PHOTO_UPLOADED",
      resourceType: "DOCUMENT",
      resourceId: doc.id,
      metadata: { taskCode: task.code, phase, sizeBytes: buf.length },
    });

    return ok(doc, 201);
  }
);
