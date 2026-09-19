// MOHD.HMS ENTERPRISE — IRMS object storage (S3/MinIO) + shared inspection helpers.
//
// CONTRACT (docs/irms-contracts.md §Storage — S3 edition):
//   Bucket:     S3_BUCKET (hms-files) on the app's S3-compatible object store.
//   Object keys: irms/{reportId}/{photoId}-{variant}.{ext}   variant ∈ original|display|thumb
//                irms/{reportId}/signatures/{signatureId}.png
//   DB stores OBJECT KEYS in storagePath/displayPath/thumbPath. Originals are
//   stored EXACTLY as uploaded (non-destructive); display (≤1600px jpeg q82)
//   and thumb (≤320px jpeg q78) variants are EXIF-rotated. EXIF subset exposed
//   is sanitized — NEVER GPS.
//
// Upload validation follows the pipeline spec:
//   §4  — validate ACTUAL bytes (magic-number sniffing); never trust the
//         client's MIME type or filename extension alone, and never reject a
//         valid image merely because its declared MIME is imperfect.
//   §5  — validate → decode → EXIF-rotate → normalize → variants → store →
//         confirm object → DB metadata → response (DB row is only kept when
//         the objects exist; failures clean up rows AND objects).
//   §7  — JPEG / PNG / WebP supported; HEIC/HEIF detected and rejected with a
//         specific, actionable message (never a generic processing error).
//   §16 — no DB record without its objects; no orphan objects after failure.
//   §19 — every failure maps to a stable error code + honest user message.

import "server-only";
import sharp from "sharp";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { storage, StorageError } from "@/lib/hms/storage";
import { PERMISSIONS, IRMS_PHOTO_CATEGORIES, IRMS_PHOTO_PREFIX } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import type { Prisma } from "@prisma/client";

export type TxClient = Prisma.TransactionClient;

/** S3 key prefix for every IRMS object (module namespace inside the bucket). */
export const IRMS_KEY_PREFIX = "irms";
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB per file (§Storage)

// ─── Upload error taxonomy (§19) ─────────────────────────────────────────────

export type UploadErrorCode =
  | "INVALID_FILE"
  | "UNSUPPORTED_FORMAT"
  | "FILE_TOO_LARGE"
  | "IMAGE_PROCESSING_FAILED"
  | "STORAGE_UPLOAD_FAILED";

/** Upload failure with a stable code and an honest, actionable user message. */
export class UploadValidationError extends Error {
  code: UploadErrorCode;
  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function extForMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "bin";
}

// ─── Content sniffing (§4 — bytes are the source of truth) ───────────────────

export type SniffedImage = { mime: string; ext: string };

/** HEIC/HEIF/AVIF ISO-BMFF brands (ftyp box) — detectable, not decodable by sharp. */
const FTYP_UNSUPPORTED = new Set([
  "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "heif", "mif1", "msf1", "avif",
]);

/**
 * Detect the real image type from magic bytes. Throws UploadValidationError
 * with a specific code when the bytes are not a supported, decodable image.
 */
export function sniffImageType(buf: Buffer): SniffedImage {
  if (!buf || buf.length < 12) {
    throw new UploadValidationError("INVALID_FILE", "We could not read this image. Please try another photo.");
  }
  // JPEG: FF D8 FF (+ any third byte: E0/E1/EE/DB…)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: "image/png", ext: "png" };
  // WebP: "RIFF" .... "WEBP"
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  // ISO-BMFF (HEIC/HEIF/AVIF): "....ftyp" + brand — give the actionable hint.
  if (buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12).toLowerCase();
    if (FTYP_UNSUPPORTED.has(brand)) {
      throw new UploadValidationError(
        "UNSUPPORTED_FORMAT",
        "HEIC/HEIF images are not supported. Please set your phone camera format to JPEG (Most Compatible) and try again.",
      );
    }
  }
  throw new UploadValidationError("INVALID_FILE", "We could not read this image. Please try another photo.");
}

/** MIME + size + content validation for photo uploads (§4/§9/§29). */
export function assertImageUpload(file: File): void {
  if (!(file instanceof File)) throw new UploadValidationError("INVALID_FILE", "Upload must be a file.");
  if (file.size <= 0) throw new UploadValidationError("INVALID_FILE", "This file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError("FILE_TOO_LARGE", `Image is too large. Maximum allowed size is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`);
  }
  // NOTE: declared MIME and extension are intentionally NOT rejection criteria
  // (§4) — mobile cameras frequently report imperfect values. The actual bytes
  // are validated by sniffImageType() before anything is stored.
}

// ─── EXIF (sanitized subset — Model/DateTimeOriginal/Make/Orientation, never GPS) ───

type ExifSubset = { Make?: string; Model?: string; Orientation?: string; DateTimeOriginal?: string };

/** Locate the embedded TIFF/EXIF block inside JPEG APP1, PNG eXIf, WebP EXIF or a raw TIFF. */
function findTiff(buf: Buffer): Buffer | null {
  if (buf.length < 12) return null;
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) return buf;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 4 < buf.length) {
      if (buf[off] !== 0xff) break;
      const marker = buf[off + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const size = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && size > 8) {
        const seg = buf.subarray(off + 4, off + 2 + size);
        if (seg[0] === 0x45 && seg[1] === 0x78 && seg[2] === 0x69 && seg[3] === 0x66 && seg[4] === 0 && seg[5] === 0) {
          return Buffer.from(seg.subarray(6));
        }
      }
      off += 2 + size;
    }
    return null;
  }
  const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSig.every((b, i) => buf[i] === b)) {
    let off = 8;
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      if (type === "eXIf") return Buffer.from(buf.subarray(off + 8, off + 8 + len));
      if (type === "IDAT") break; // EXIF must precede image data per PNG spec
      off += 12 + len;
    }
    return null;
  }
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    let off = 12;
    while (off + 8 <= buf.length) {
      const type = buf.toString("ascii", off, off + 4);
      const len = buf.readUInt32LE(off + 4);
      if (type === "EXIF") {
        const payload = buf.subarray(off + 8, off + 8 + len);
        const ii = payload.indexOf(Buffer.from([0x49, 0x49, 0x2a, 0x00]));
        const mm = payload.indexOf(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
        const start = ii >= 0 ? ii : mm >= 0 ? mm : 0;
        return Buffer.from(payload.subarray(start));
      }
      off += 8 + len + (len % 2);
    }
    return null;
  }
  return null;
}

function parseTiffExifSubset(tiff: Buffer): ExifSubset {
  const out: ExifSubset = {};
  try {
    const little = tiff[0] === 0x49;
    const u16 = (o: number) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o: number) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    if (u16(2) !== 42) return out;

    const readAscii = (offset: number, count: number): string => {
      if (offset < 0 || offset + count > tiff.length) return "";
      return tiff.toString("ascii", offset, offset + count).replace(/\0+$/g, "").trim();
    };
    const readDir = (dirOff: number): Map<number, { type: number; count: number; fieldAt: number }> => {
      const map = new Map<number, { type: number; count: number; fieldAt: number }>();
      if (dirOff <= 0 || dirOff + 2 > tiff.length) return map;
      const n = u16(dirOff);
      for (let i = 0; i < n; i++) {
        const e = dirOff + 2 + i * 12;
        if (e + 12 > tiff.length) break;
        map.set(u16(e), { type: u16(e + 2), count: u32(e + 4), fieldAt: e + 8 });
      }
      return map;
    };
    const asciiValue = (dir: Map<number, { type: number; count: number; fieldAt: number }>, tag: number): string | undefined => {
      const en = dir.get(tag);
      if (!en || en.type !== 2 || en.count < 2) return undefined;
      const at = en.count <= 4 ? en.fieldAt : u32(en.fieldAt);
      const v = readAscii(at, en.count);
      return v || undefined;
    };

    const ifd0 = readDir(u32(4));
    const make = asciiValue(ifd0, 0x010f);
    const model = asciiValue(ifd0, 0x0110);
    if (make) out.Make = make.slice(0, 64);
    if (model) out.Model = model.slice(0, 64);
    const orient = ifd0.get(0x0112);
    if (orient && orient.count >= 1) {
      const v = u16(orient.fieldAt);
      if (v >= 1 && v <= 8) out.Orientation = String(v);
    }
    const exifIfdPtr = ifd0.get(0x8769);
    if (exifIfdPtr) {
      const exifIfd = readDir(u32(exifIfdPtr.fieldAt));
      const dto = asciiValue(exifIfd, 0x9003);
      if (dto) out.DateTimeOriginal = dto.slice(0, 32);
    }
  } catch {
    // Malformed EXIF must never fail an upload.
  }
  return out;
}

/** EXIF "YYYY:MM:DD HH:MM:SS" → Date (camera wall clock treated as server time). */
function exifDateToDateTime(value: string | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return isNaN(d.getTime()) ? null : d;
}

function sanitizeExif(buf: Buffer): { subset: ExifSubset; takenAt: Date | null } {
  const tiff = findTiff(buf);
  const subset = tiff ? parseTiffExifSubset(tiff) : {};
  return { subset, takenAt: exifDateToDateTime(subset.DateTimeOriginal) };
}

// ─── Photo variants ──────────────────────────────────────────────────────────

export type PhotoVariantsResult = {
  storagePath: string;
  displayPath: string;
  thumbPath: string;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: string;
  cameraModel: string;
  takenAt: Date | null;
  exif: string; // sanitized JSON subset — NEVER GPS
};

/** One photo fully decoded in memory (variants + metadata) before anything is stored. */
type PreparedPhoto = {
  original: Buffer;
  display: Buffer;
  thumb: Buffer;
  sniffed: SniffedImage;
  width: number;
  height: number;
  exif: string;
  cameraModel: string;
  takenAt: Date | null;
};

export type PreparedPhotoInternal = PreparedPhoto;

/** Deterministic, collision-safe object keys: {module}/{reportId}/{photoId}-{variant}.{ext} (§14). */
export function photoObjectKeys(reportId: string, photoId: string, ext: string): { original: string; display: string; thumb: string } {
  return {
    original: `${IRMS_KEY_PREFIX}/${reportId}/${photoId}-original.${ext}`,
    display: `${IRMS_KEY_PREFIX}/${reportId}/${photoId}-display.jpg`,
    thumb: `${IRMS_KEY_PREFIX}/${reportId}/${photoId}-thumb.jpg`,
  };
}

/**
 * §5/§16 — validate + decode + derive ALL variants in memory first. A corrupt
 * or unsupported image fails HERE, before any DB row or object is created.
 */
export async function preparePhotoUpload(file: File): Promise<PreparedPhoto> {
  const buf = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffImageType(buf); // §4 — bytes decide, not the client MIME

  // Decode/normalize in memory: a decoder failure must not leave orphans.
  let display: Buffer;
  let thumb: Buffer;
  try {
    display = await sharp(buf)
      .rotate() // bake EXIF orientation into processed variants only (§6)
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    thumb = await sharp(buf)
      .rotate()
      .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "image.processing.failed", mime: file.type, sniffed: sniffed.mime, size: buf.length, error: String(err) }));
    throw new UploadValidationError("IMAGE_PROCESSING_FAILED", "We could not read this image. Please try another photo.");
  }

  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(display).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    // metadata failure must not fail the upload
  }

  const { subset, takenAt } = sanitizeExif(buf);
  return {
    original: buf,
    display,
    thumb,
    sniffed,
    width,
    height,
    cameraModel: subset.Model ?? "",
    takenAt,
    exif: JSON.stringify(subset), // Model/DateTimeOriginal/Make/Orientation only — never GPS
  };
}

/**
 * §16 — store the confirmed variants in the object store. The DB row is only
 * completed by the caller AFTER this succeeds; if any object fails, the
 * already-uploaded objects are removed so no orphans remain.
 */
export async function storePreparedPhoto(prepared: PreparedPhoto, keys: { original: string; display: string; thumb: string }): Promise<PhotoVariantsResult> {
  try {
    await storage.put(keys.original, prepared.original, prepared.sniffed.mime); // as-uploaded, untouched (§14/§48)
    await storage.put(keys.display, prepared.display, "image/jpeg");
    await storage.put(keys.thumb, prepared.thumb, "image/jpeg");
  } catch (err) {
    await deleteFiles([keys.original, keys.display, keys.thumb]);
    if (err instanceof StorageError || err instanceof UploadValidationError) {
      throw new UploadValidationError("STORAGE_UPLOAD_FAILED", "Storage service is temporarily unavailable. Please try again.");
    }
    throw err;
  }
  return {
    storagePath: keys.original,
    displayPath: keys.display,
    thumbPath: keys.thumb,
    width: prepared.width,
    height: prepared.height,
    sizeBytes: prepared.original.length,
    mimeType: prepared.sniffed.mime,
    cameraModel: prepared.cameraModel,
    takenAt: prepared.takenAt,
    exif: prepared.exif,
  };
}

/**
 * Save one uploaded photo non-destructively (single-file convenience used by
 * tests/tools): prepare in memory → store objects → return variant metadata.
 */
export async function savePhotoVariants(file: File, reportId: string, photoId: string): Promise<PhotoVariantsResult> {
  const prepared = await preparePhotoUpload(file);
  return storePreparedPhoto(prepared, photoObjectKeys(reportId, photoId, prepared.sniffed.ext));
}

// ─── Signatures ──────────────────────────────────────────────────────────────

/** Accepts a PNG Blob/File or a dataURL/base64 string; validates the PNG magic; stores as-is. */
export async function saveSignature(data: Blob | string, reportId: string, signatureId: string): Promise<{ storagePath: string; sizeBytes: number }> {
  let buf: Buffer;
  if (typeof data === "string") {
    const s = data.trim();
    const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(s);
    buf = Buffer.from(m ? m[1] : s, "base64");
  } else {
    buf = Buffer.from(await data.arrayBuffer());
  }
  if (buf.length === 0) throw new UploadValidationError("INVALID_FILE", "Signature image is empty.");
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError("FILE_TOO_LARGE", `Signature image exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`);
  }
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) throw new UploadValidationError("UNSUPPORTED_FORMAT", "Signature image must be a PNG.");
  const key = `${IRMS_KEY_PREFIX}/${reportId}/signatures/${signatureId}.png`;
  await storage.put(key, buf, "image/png");
  return { storagePath: key, sizeBytes: buf.length };
}

// ─── File serving / deletion ─────────────────────────────────────────────────

/** Read a stored variant from object storage; null when missing (caller turns this into 404). */
export async function readVariantFile(key: string | null | undefined): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!key) return null;
  const obj = await storage.get(key);
  if (!obj) return null;
  // Prefer the stored content type; fall back to the key extension when the
  // object was uploaded without usable metadata.
  if (obj.contentType && obj.contentType !== "application/octet-stream") return obj;
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return { buffer: obj.buffer, contentType: MIME_BY_EXT[ext] ?? obj.contentType };
}

/** Best-effort delete of specific stored objects (never throws, idempotent). */
export async function deleteFiles(keys: (string | null | undefined)[]): Promise<void> {
  for (const key of keys) {
    if (!key) continue;
    await storage.remove(key);
  }
}

/** Remove a report's whole storage namespace (report delete only). */
export async function deleteReportDir(reportId: string): Promise<void> {
  await storage.removePrefix(`${IRMS_KEY_PREFIX}/${reportId}/`);
}

// ─── Photo numbering (§Storage) ──────────────────────────────────────────────

/**
 * Regenerate photoNo for a report: per category, in canonical IRMS_PHOTO_CATEGORIES
 * order and sortOrder asc, prefix + zero-padded 3-digit sequence (B001, B002…).
 * Must run after every upload / delete / category change / reorder / bulk edit.
 */
export async function regeneratePhotoNo(reportId: string, tx: TxClient): Promise<void> {
  const photos = await tx.inspectionPhoto.findMany({
    where: { reportId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, category: true, photoNo: true },
  });
  for (const category of IRMS_PHOTO_CATEGORIES) {
    let n = 0;
    for (const p of photos) {
      if (p.category !== category) continue;
      n += 1;
      const no = `${IRMS_PHOTO_PREFIX[category] ?? "X"}${String(n).padStart(3, "0")}`;
      if (p.photoNo !== no) {
        await tx.inspectionPhoto.update({ where: { id: p.id }, data: { photoNo: no } });
      }
    }
  }
}

// ─── Shared report helpers (single source of truth for all IRMS routes) ──────

export const IRMS_EDITABLE_STATUSES = ["DRAFT", "REJECTED"] as const;
export const IRMS_REVIEW_ACTIVE_STATUSES = ["SUBMITTED", "IN_REVIEW", "MANAGER_APPROVAL", "CLIENT_REVIEW"] as const;
export const IRMS_OVERDUE_STATUSES = ["DRAFT", "SUBMITTED", "IN_REVIEW", "MANAGER_APPROVAL", "CLIENT_REVIEW"] as const;

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Overdue predicate (§35): inspectionDate < today(start of day, server) AND status still open. */
export function overdueWhere(): Record<string, unknown> {
  return { inspectionDate: { lt: startOfToday() }, status: { in: [...IRMS_OVERDUE_STATUSES] } };
}

export function isEditableStatus(status: string): boolean {
  return (IRMS_EDITABLE_STATUSES as readonly string[]).includes(status);
}

export function isReviewActiveStatus(status: string): boolean {
  return (IRMS_REVIEW_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * Shared auth + status gate for photo mutations (upload / reorder / bulk /
 * metadata edit — contract §8 status rules):
 *   editable (DRAFT|REJECTED) → owner | MANAGE
 *   review-active             → MANAGE only (evidence during review)
 *   APPROVED | ARCHIVED       → 422 (immutable)
 */
export async function requirePhotoEditor(id: string, user: SessionUser) {
  const report = await db.inspectionReport.findUnique({
    where: { id },
    include: { inspector: { select: { userId: true } } },
  });
  if (!report) throw Errors.notFound("Inspection report not found.");
  const canManage = roleCan(user.role, PERMISSIONS.irms_manage);
  const isOwner = !!report.inspector && report.inspector.userId === user.id;
  if (report.status === "APPROVED" || report.status === "ARCHIVED") {
    throw Errors.invalidTransition("Photos of approved or archived reports can no longer be changed.");
  }
  if (isReviewActiveStatus(report.status)) {
    if (!canManage) throw Errors.forbidden("Only supervisors/admins can manage photos while the report is in review.");
  } else if (isEditableStatus(report.status)) {
    if (!canManage && !isOwner) throw Errors.forbidden("Only the owning inspector or a supervisor can manage photos.");
  } else {
    throw Errors.invalidTransition("Photos can only be managed on draft, rejected or review-active reports.");
  }
  return { report, canManage, isOwner };
}

/** Canonical ordering: category (IRMS_PHOTO_CATEGORIES order) then sortOrder asc. */
export function canonicalPhotoOrder<T extends { category: string; sortOrder: number }>(photos: T[]): T[] {
  const idx = new Map<string, number>(IRMS_PHOTO_CATEGORIES.map((c, i) => [c as string, i]));
  return [...photos].sort((a, b) => (idx.get(a.category) ?? 99) - (idx.get(b.category) ?? 99) || a.sortOrder - b.sortOrder);
}

export type InspectionPhotoDtoRow = {
  id: string;
  category: string;
  photoNo: string;
  sortOrder: number;
  caption: string;
  swRef: string;
  room: string;
  building: string;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: string;
  cameraModel: string;
  takenAt: Date | null;
  rotation: number;
  annotation: string;
};

/** Staff-facing photo item (contract §3/§8 — includes exif-derived fields + annotation). */
export function photoItemDto(p: InspectionPhotoDtoRow) {
  return {
    id: p.id,
    category: p.category,
    photoNo: p.photoNo,
    sortOrder: p.sortOrder,
    caption: p.caption,
    swRef: p.swRef,
    room: p.room,
    building: p.building,
    width: p.width,
    height: p.height,
    sizeBytes: p.sizeBytes,
    mimeType: p.mimeType,
    cameraModel: p.cameraModel,
    takenAt: p.takenAt,
    rotation: p.rotation,
    annotation: p.annotation,
    urls: {
      thumb: `/api/v1/irms/photos/${p.id}/file?variant=thumb`,
      display: `/api/v1/irms/photos/${p.id}/file?variant=display`,
      original: `/api/v1/irms/photos/${p.id}/file?variant=original`,
    },
  };
}

// ─── Report snapshot / restore (§7 — revision history) ───────────────────────

export type SnapshotFindings = { finding: string; severity: string; recommendation: string }[];

export type SnapshotSource = {
  title: string;
  type: string;
  priority: string;
  inspectionDate: Date;
  inspectorId: string | null;
  equipmentId: string | null;
  workOrderId: string | null;
  summary: string;
  overallCondition: string;
  recommendations: string;
  jobOrderNo: string;
  building: string;
  floor: string;
  room: string;
  taskDescription: string;
  scope: string;
  notes: string;
  correctiveActions: string;
  rootCause: string;
  safetyNotes: string;
  materials: string;
  labourHours: number;
  completionPercent: number;
  customerVisible: boolean;
  clientComment: string;
};

/** Snapshot shape: {report fields..., findings:[...]} (contract §7). */
export function buildSnapshot(source: SnapshotSource, findings: SnapshotFindings): string {
  return JSON.stringify({
    report: {
      title: source.title,
      type: source.type,
      priority: source.priority,
      inspectionDate: source.inspectionDate,
      inspectorId: source.inspectorId,
      equipmentId: source.equipmentId,
      workOrderId: source.workOrderId,
      summary: source.summary,
      overallCondition: source.overallCondition,
      recommendations: source.recommendations,
      jobOrderNo: source.jobOrderNo,
      building: source.building,
      floor: source.floor,
      room: source.room,
      taskDescription: source.taskDescription,
      scope: source.scope,
      notes: source.notes,
      correctiveActions: source.correctiveActions,
      rootCause: source.rootCause,
      safetyNotes: source.safetyNotes,
      materials: source.materials,
      labourHours: source.labourHours,
      completionPercent: source.completionPercent,
      customerVisible: source.customerVisible,
      clientComment: source.clientComment,
    },
    findings,
  });
}

/** Parse a stored snapshot back into patch data; null when corrupt. */
export function parseSnapshot(snapshot: string): { report: Partial<SnapshotSource>; findings: SnapshotFindings } | null {
  try {
    const raw = JSON.parse(snapshot) as { report?: Partial<SnapshotSource>; findings?: SnapshotFindings };
    if (!raw || typeof raw !== "object" || !raw.report) return null;
    return { report: raw.report, findings: Array.isArray(raw.findings) ? raw.findings : [] };
  } catch {
    return null;
  }
}
