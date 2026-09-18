// MOHD.HMS ENTERPRISE — IRMS filesystem storage + shared inspection helpers.
//
// CONTRACT (docs/irms-contracts.md §Storage layout):
//   Base dir: path.join(process.cwd(), "uploads", "irms")
//   Photos:     {reportId}/{photoId}-{variant}.{ext}   variant ∈ original|display|thumb
//   Signatures: {reportId}/signatures/{signatureId}.png
//   DB stores RELATIVE paths (from uploads/irms). Originals are stored EXACTLY as
//   uploaded (non-destructive); display (≤1600px jpeg q82) and thumb (≤320px jpeg
//   q78) variants are EXIF-rotated. EXIF subset exposed is sanitized — NEVER GPS.
//
// This module also hosts the small shared server-side helpers every IRMS route
// needs (photo DTO shaping, canonical ordering, overdue predicate, report
// snapshot/restore) so route files never drift from the contract.

import "server-only";
import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { PERMISSIONS, IRMS_PHOTO_CATEGORIES, IRMS_PHOTO_PREFIX } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import type { Prisma } from "@prisma/client";

export type TxClient = Prisma.TransactionClient;

export const IRMS_UPLOAD_ROOT = path.join(process.cwd(), "uploads", "irms");

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB per file (§Storage)

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

/** Safe-join guard: the resolved path must stay inside uploads/irms (§49 path traversal). */
export function resolveFile(relPath: string): string {
  const base = path.resolve(IRMS_UPLOAD_ROOT);
  const abs = path.resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error("Invalid storage path.");
  }
  return abs;
}

/** MIME + size + extension whitelist for photo uploads (§Storage). */
export function assertImageUpload(file: File): void {
  if (!(file instanceof File)) throw Errors.badRequest("Upload must be a file.");
  if (!ALLOWED_MIME.has(file.type)) {
    throw Errors.badRequest("Only JPEG, PNG or WebP images are allowed.");
  }
  const ext = path.extname(file.name || "").replace(".", "").toLowerCase();
  if (ext && !(ext in MIME_BY_EXT)) {
    throw Errors.badRequest("File extension does not match an allowed image type (jpg, jpeg, png, webp).");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw Errors.badRequest("Image exceeds the 15MB upload limit.");
  }
  if (file.size <= 0) throw Errors.badRequest("Uploaded file is empty.");
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

/**
 * Save one uploaded photo non-destructively:
 *  - original: exactly the uploaded bytes;
 *  - display: EXIF-rotated, max edge 1600px, jpeg q82;
 *  - thumb:   EXIF-rotated, max edge 320px, jpeg q78.
 */
export async function savePhotoVariants(file: File, reportId: string, photoId: string): Promise<PhotoVariantsResult> {
  const buf = Buffer.from(await file.arrayBuffer());
  const dir = reportId;
  await fs.mkdir(resolveFile(dir), { recursive: true });

  const ext = extForMime(file.type || "image/jpeg");
  const storagePath = path.join(dir, `${photoId}-original.${ext}`);
  await fs.writeFile(resolveFile(storagePath), buf); // as-uploaded, untouched (§14/§16)

  const display = await sharp(buf)
    .rotate() // bake EXIF orientation into processed variants only
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  const thumb = await sharp(buf)
    .rotate()
    .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();

  const displayPath = path.join(dir, `${photoId}-display.jpg`);
  const thumbPath = path.join(dir, `${photoId}-thumb.jpg`);
  await fs.writeFile(resolveFile(displayPath), display);
  await fs.writeFile(resolveFile(thumbPath), thumb);

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
    storagePath,
    displayPath,
    thumbPath,
    width,
    height,
    sizeBytes: buf.length,
    mimeType: file.type || "image/jpeg",
    cameraModel: subset.Model ?? "",
    takenAt,
    exif: JSON.stringify(subset), // Model/DateTimeOriginal/Make/Orientation only — never GPS
  };
}

// ─── Signatures ──────────────────────────────────────────────────────────────

/** Accepts a PNG Blob/File or a dataURL/base64 string; validates the PNG magic; saves as-is. */
export async function saveSignature(data: Blob | string, reportId: string, signatureId: string): Promise<{ storagePath: string; sizeBytes: number }> {
  let buf: Buffer;
  if (typeof data === "string") {
    const s = data.trim();
    const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(s);
    buf = Buffer.from(m ? m[1] : s, "base64");
  } else {
    buf = Buffer.from(await data.arrayBuffer());
  }
  if (buf.length === 0) throw Errors.badRequest("Signature image is empty.");
  if (buf.length > MAX_UPLOAD_BYTES) throw Errors.badRequest("Signature image exceeds the 15MB limit.");
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) throw Errors.badRequest("Signature image must be a PNG.");
  const rel = path.join(reportId, "signatures", `${signatureId}.png`);
  const abs = resolveFile(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
  return { storagePath: rel, sizeBytes: buf.length };
}

// ─── File serving / deletion ─────────────────────────────────────────────────

/** Read a stored variant file; null when missing (caller turns this into 404). */
export async function readVariantFile(relPath: string | null | undefined): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!relPath) return null;
  try {
    const buffer = await fs.readFile(resolveFile(relPath));
    const ext = path.extname(relPath).slice(1).toLowerCase();
    return { buffer, contentType: MIME_BY_EXT[ext] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

/** Best-effort delete of specific stored files (never throws). */
export async function deleteFiles(relPaths: (string | null | undefined)[]): Promise<void> {
  for (const rel of relPaths) {
    if (!rel) continue;
    try {
      await fs.unlink(resolveFile(rel));
    } catch {
      // already gone — deletion is idempotent
    }
  }
}

/** Remove a report's whole storage folder (report delete only). */
export async function deleteReportDir(reportId: string): Promise<void> {
  try {
    await fs.rm(resolveFile(reportId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
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
