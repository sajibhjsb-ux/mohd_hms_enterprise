import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS, IRMS_PHOTO_CATEGORIES } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { deleteFiles, photoItemDto, regeneratePhotoNo, requirePhotoEditor, type TxClient } from "@/lib/hms/irms/storage";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c))(req);
  };
}

// ── Annotation validation (§8): JSON array of shapes normalized 0..1 ────────

const shapeSchema = z
  .object({
    type: z.enum(["arrow", "circle", "rect", "highlight", "text"]),
    x: z.coerce.number().min(0).max(1),
    y: z.coerce.number().min(0).max(1),
    w: z.coerce.number().min(0).max(1),
    h: z.coerce.number().min(0).max(1),
    color: z.string().max(32).optional(),
    text: z.string().max(500).optional(),
  })
  .passthrough();

const annotationSchema = z
  .string()
  .max(50_000, "Annotation payload is too large (max 50,000 characters).")
  .refine(
    (raw) => {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return false;
        return parsed.every((item) => shapeSchema.safeParse(item).success);
      } catch {
        return false;
      }
    },
    { message: "Annotation must be a JSON array of shapes with x/y/w/h normalized 0..1." }
  );

const patchSchema = z.object({
  caption: z.string().max(300).optional(),
  swRef: z.string().max(120).optional(),
  room: z.string().max(120).optional(),
  building: z.string().max(160).optional(),
  category: z.enum(IRMS_PHOTO_CATEGORIES).optional(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  annotation: annotationSchema.optional(),
});

async function loadPhotoForEdit(id: string, user: SessionUser) {
  const photo = await db.inspectionPhoto.findUnique({ where: { id } });
  if (!photo) throw Errors.notFound("Photo not found.");
  const { report } = await requirePhotoEditor(photo.reportId, user);
  return { photo, report };
}

// ── 8e. PATCH /api/v1/irms/photos/[id] — metadata (+ annotation) ────────────

export const PATCH = withId(
  async (id, { req, user }) => {
    const { photo, report } = await loadPhotoForEdit(id, user);
    const body = await parseBody(req, patchSchema);

    const updated = await db.$transaction(async (tx: TxClient) => {
      const row = await tx.inspectionPhoto.update({
        where: { id },
        data: {
          ...(body.caption !== undefined ? { caption: body.caption } : {}),
          ...(body.swRef !== undefined ? { swRef: body.swRef } : {}),
          ...(body.room !== undefined ? { room: body.room } : {}),
          ...(body.building !== undefined ? { building: body.building } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.rotation !== undefined ? { rotation: body.rotation } : {}),
          ...(body.annotation !== undefined ? { annotation: body.annotation } : {}),
        },
      });
      // Category change moves the photo between numbering scopes → renumber all.
      if (body.category !== undefined && body.category !== photo.category) {
        await regeneratePhotoNo(photo.reportId, tx);
      }
      return row;
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_PHOTO_UPDATED",
      resourceType: "INSPECTION_PHOTO",
      resourceId: id,
      metadata: { reportCode: report.code, fields: Object.keys(body) },
    });
    await emit({
      type: EVENT_TYPES.IRMS_PHOTOS_UPDATED,
      resourceType: "INSPECTION_REPORT",
      resourceId: photo.reportId,
      payload: { reportId: photo.reportId, code: report.code, status: report.status, category: updated.category },
      actorType: "USER",
      actorId: user.id,
    });
    return ok(photoItemDto(updated));
  }
);

// ── 8f. DELETE /api/v1/irms/photos/[id] — files + row + renumber ────────────

export const DELETE = withId(
  async (id, { user }) => {
    const { photo, report } = await loadPhotoForEdit(id, user);

    await db.inspectionPhoto.delete({ where: { id } });
    await deleteFiles([photo.storagePath, photo.displayPath, photo.thumbPath]);
    await db.$transaction(async (tx: TxClient) => {
      await regeneratePhotoNo(photo.reportId, tx);
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_PHOTO_DELETED",
      resourceType: "INSPECTION_PHOTO",
      resourceId: id,
      metadata: { reportCode: report.code, category: photo.category, photoNo: photo.photoNo },
    });
    await emit({
      type: EVENT_TYPES.IRMS_PHOTOS_UPDATED,
      resourceType: "INSPECTION_REPORT",
      resourceId: photo.reportId,
      payload: { reportId: photo.reportId, code: report.code, status: report.status, category: photo.category },
      actorType: "USER",
      actorId: user.id,
    });
    return ok({ deleted: true, id });
  }
);
