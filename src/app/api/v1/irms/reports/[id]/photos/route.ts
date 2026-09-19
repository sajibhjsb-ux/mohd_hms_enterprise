import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, ok as okJson, Errors, ApiError } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS, IRMS_PHOTO_CATEGORIES } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import {
  assertImageUpload,
  canonicalPhotoOrder,
  deleteFiles,
  photoItemDto,
  photoObjectKeys,
  preparePhotoUpload,
  regeneratePhotoNo,
  requirePhotoEditor,
  storePreparedPhoto,
  UploadValidationError,
  type TxClient,
} from "@/lib/hms/irms/storage";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission: PERMISSIONS.irms_read })(req);
  };
}

// ── 8a. GET /api/v1/irms/reports/[id]/photos (STAFF_READ) ───────────────────

export const GET = withId(
  async (id) => {
    const report = await db.inspectionReport.findUnique({ where: { id }, select: { id: true } });
    if (!report) throw Errors.notFound("Inspection report not found.");
    const photos = await db.inspectionPhoto.findMany({
      where: { reportId: id },
      orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
    });
    return okList(canonicalPhotoOrder(photos).map((p) => photoItemDto(p)));
  }
);

// ── 8b. POST — multipart upload (one or many), S3 variants, numbering ───────

const MAX_FILES_PER_REQUEST = 24;

/** Upload-validation failures keep their honest code + user-facing message. */
function failUpload(err: unknown): never {
  if (err instanceof UploadValidationError) throw new ApiError(422, err.code, err.message);
  throw err instanceof Error ? err : Errors.badRequest("Upload failed.");
}

export const POST = withId(
  async (id, { req, user }) => {
    const { report } = await requirePhotoEditor(id, user);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw Errors.badRequest("Expected a multipart form upload.");
    }
    const rawCategory = form.get("category");
    const category = typeof rawCategory === "string" && rawCategory ? rawCategory : "BEFORE";
    if (!(IRMS_PHOTO_CATEGORIES as readonly string[]).includes(category)) {
      throw Errors.badRequest("Unknown photo category.");
    }
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) throw Errors.badRequest("No image files were uploaded (field name: files).");
    if (files.length > MAX_FILES_PER_REQUEST) {
      throw Errors.badRequest(`Too many files in one request (max ${MAX_FILES_PER_REQUEST}).`);
    }

    // Phase 1 — validate + decode + derive ALL variants in memory FIRST (§5).
    // A corrupt/unsupported/oversized image fails here with a specific code
    // and honest message BEFORE any DB row or object is created (§16/§46 —
    // no partial state, never a generic "could not be processed").
    const prepared = [];
    for (const file of files) {
      try {
        assertImageUpload(file);
        prepared.push(await preparePhotoUpload(file));
      } catch (err) {
        failUpload(err);
      }
    }

    // Phase 2 — persist: create row → store objects (confirmed) → complete row.
    // Any failure deletes that row AND its objects with a rollback of rows
    // created during this request — no DB record without its objects, no
    // orphan objects (§16).
    const created: Awaited<ReturnType<typeof db.inspectionPhoto.create>>[] = [];
    try {
      const maxSort = await db.inspectionPhoto.aggregate({ where: { reportId: id }, _max: { sortOrder: true } });
      let nextSort = (maxSort._max.sortOrder ?? 0) + 1;
      for (const item of prepared) {
        const row = await db.inspectionPhoto.create({
          data: { reportId: id, category, sortOrder: nextSort++, uploadedById: user.id },
        });
        try {
          const keys = photoObjectKeys(id, row.id, item.sniffed.ext);
          const variants = await storePreparedPhoto(item, keys);
          const updated = await db.inspectionPhoto.update({ where: { id: row.id }, data: { ...variants } });
          created.push(updated);
        } catch (err) {
          await db.inspectionPhoto.delete({ where: { id: row.id } }).catch(() => undefined);
          throw err;
        }
      }
    } catch (err) {
      for (const row of created) {
        await db.inspectionPhoto.delete({ where: { id: row.id } }).catch(() => undefined);
        await deleteFiles([row.storagePath, row.displayPath, row.thumbPath]);
      }
      failUpload(err);
    }

    // Renumber the whole category set inside one transaction (§Storage numbering).
    await db.$transaction(async (tx: TxClient) => {
      await regeneratePhotoNo(id, tx);
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_PHOTO_UPLOADED",
      resourceType: "INSPECTION_PHOTO",
      resourceId: id,
      metadata: { count: created.length, category, reportCode: report.code },
    });

    await emit({
      type: EVENT_TYPES.IRMS_PHOTOS_UPDATED,
      resourceType: "INSPECTION_REPORT",
      resourceId: id,
      payload: { reportId: id, code: report.code, status: report.status, category },
      actorType: "USER",
      actorId: user.id,
    });

    return okJson(created.map((p) => photoItemDto(p)), 201);
  }
);
