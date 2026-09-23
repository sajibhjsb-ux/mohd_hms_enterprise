// MOHD.HMS ENTERPRISE — Work order checklist photo evidence (AI checklist spec §33/§67).
// GET  /api/v1/work-orders/[id]/photos — list evidence rows (metadata only).
// POST /api/v1/work-orders/[id]/photos — multipart upload (field: file, itemId?).
//   Assigned technician, or work_orders_update. Photos live in MinIO under
//   checklists/{woId}/photos/ (spec §67 object-key convention); PostgreSQL stores
//   the metadata reference only. Upload validation is by magic bytes — images
//   jpeg/png/webp ≤ 15 MB, videos mp4/webm ≤ 50 MB. itemId links the photo to
//   the requiresPhoto checklist item it satisfies (completion validation, §32).

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";
import { assertViewWorkOrder } from "../../_lib";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>, permission?: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

type SniffedMedia = { mime: string; ext: string; kind: "image" | "video" };

/** Local magic-byte sniffer (jpeg/png/webp images, mp4/webm videos) — bytes are the truth. */
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

// ── GET — evidence list (metadata only; bytes via /photos/[photoId]/file) ────

export const GET = withId(
  async (id, { user }) => {
    const wo = await db.workOrder.findUnique({ where: { id }, select: { customerId: true, technicianId: true } });
    if (!wo) throw Errors.notFound("Work order not found.");
    await assertViewWorkOrder(user, wo);
    const photos = await db.document.findMany({
      where: { resourceType: "WORK_ORDER", resourceId: id, category: "WORK_ORDER" },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, mimeType: true, sizeBytes: true, label: true, createdAt: true },
    });
    return ok(photos);
  },
  PERMISSIONS.work_orders_read
);

// ── POST — multipart upload (one file per request) ──────────────────────────

export const POST = withId(
  async (id, { req, user }) => {
    const wo = await db.workOrder.findUnique({
      where: { id },
      select: { id: true, code: true, status: true, technician: { select: { userId: true } } },
    });
    if (!wo) throw Errors.notFound("Work order not found.");

    const isUpdater = roleCan(user.role, PERMISSIONS.work_orders_update);
    const isAssignedTech = !!wo.technician && wo.technician.userId === user.id;
    if (!isUpdater && !isAssignedTech) throw Errors.forbidden();
    if (["COMPLETED", "CANCELLED"].includes(wo.status) && !isUpdater) {
      throw Errors.invalidTransition("This work order is closed — photos can no longer be added.");
    }

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
    // Optional itemId — links the evidence photo to its requiresPhoto task.
    const itemIdRaw = form.get("itemId");
    const itemId = typeof itemIdRaw === "string" && itemIdRaw.trim() ? itemIdRaw.trim() : "";
    if (itemId) {
      const item = await db.workOrderChecklistItem.findUnique({ where: { id: itemId }, select: { workOrderId: true } });
      if (!item || item.workOrderId !== id) throw Errors.badRequest("itemId does not belong to this work order.");
    }

    // Optional phase — BEFORE | DURING | AFTER evidence label (§15/§18).
    // The Start Work gate counts real BEFORE records, never a boolean flag.
    const phaseRaw = form.get("phase");
    const validPhases = new Set(["BEFORE", "DURING", "AFTER"]);
    const phase = typeof phaseRaw === "string" && validPhases.has(phaseRaw) ? phaseRaw : "CHECKLIST";
    if (phase !== "CHECKLIST" && itemId) {
      throw Errors.badRequest("A checklist-linked photo cannot also carry an evidence phase. Upload it twice with separate fields.");
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

    const key = `checklists/${wo.id}/photos/${randomUUID()}.${sniffed.ext}`;
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
        resourceType: "WORK_ORDER",
        resourceId: wo.id,
        label: itemId || phase,
        uploadedById: user.id,
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "WO_CHECKLIST_PHOTO_UPLOADED",
      resourceType: "DOCUMENT",
      resourceId: doc.id,
      metadata: { workOrderCode: wo.code, itemId: itemId || null, sizeBytes: buf.length },
    });

    return ok(doc, 201);
  }
);
