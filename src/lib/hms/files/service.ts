// MOHD.HMS ENTERPRISE — Files module service (spec §7/§11/§12/§13/§15/§17/§29/§36).
//
// THE object-level authorization core for the Files module. Every Files API
// route funnels access decisions through canAccessFile/canAccessFolder —
// ownership + explicit grants only. Role permissions (files.read etc.) are a
// COARSE gate; they never bypass per-object authorization. Administrators see
// aggregate storage/audit data, never user file CONTENT, unless explicitly
// shared — private files stay private (spec §12/§39).
//
//   VIEW ⊆ DOWNLOAD ⊆ EDIT ⊆ MANAGE
//
//   owner            → full (MANAGE)
//   file share       → granted level on that file (direct §13)
//   folder share     → granted level on the folder + every descendant
//                      (inherited §15) incl. contained files
//   revoked/expired  → immediately no access (shares are never cached)

import "server-only";
import { createHash, randomUUID } from "crypto";
import { db } from "@/lib/db";
import type { Permission } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { Errors } from "@/lib/hms/api";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { getAutomationSetting } from "@/lib/hms/workflows/settings";

// ─── Shared share-model vocabulary ──────────────────────────────────────────

export type ShareTargetType = "FILE" | "FOLDER";
export type SharePermission = "VIEW" | "DOWNLOAD" | "EDIT" | "MANAGE";

const PERM_RANK: Record<SharePermission, number> = { VIEW: 0, DOWNLOAD: 1, EDIT: 2, MANAGE: 3 };

export function normalizeSharePermission(v: string): SharePermission {
  const p = String(v || "").toUpperCase() as SharePermission;
  if (!(p in PERM_RANK)) throw Errors.badRequest("Permission must be one of VIEW, DOWNLOAD, EDIT, MANAGE.");
  return p;
}

function satisfies(granted: SharePermission, need: SharePermission): boolean {
  return PERM_RANK[granted] >= PERM_RANK[need];
}

/** Coarse role gate (§31) — call in addition to object-level checks. */
export function assertRolePermission(user: { id: string }, permission: Permission): void {
  if (!roleCan(user.role, permission)) throw Errors.forbidden("You do not have the required role permission.");
}

// ─── Active grant lookup (revocation/expiry enforced on EVERY check) ────────

async function activeGrants(targetType: ShareTargetType, targetIds: string[], userId: string): Promise<Map<string, SharePermission>> {
  const map = new Map<string, SharePermission>();
  if (targetIds.length === 0) return map;
  const grants = await db.fileShare.findMany({
    where: {
      targetType,
      targetId: { in: targetIds },
      sharedWithId: userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { targetId: true, permission: true },
    orderBy: { createdAt: "desc" },
  });
  for (const g of grants) {
    const perm = g.permission as SharePermission;
    const prev = map.get(g.targetId);
    if (!prev || PERM_RANK[perm] > PERM_RANK[prev]) map.set(g.targetId, perm);
  }
  return map;
}

// ─── Folder tree helpers (§7 — hierarchy, cycles, descendants) ──────────────

export type FolderChainNode = { id: string; name: string; parentId: string | null };

/** Walk UP from a folder to its root; returns [root, …, folder] (breadcrumb chain). */
export async function folderChain(folderId: string, ownerId: string): Promise<FolderChainNode[]> {
  const chain: FolderChainNode[] = [];
  let cursor: string | null = folderId;
  let depth = 0;
  while (cursor && depth < 64) {
    // depth cap = hard cycle guard (§7) — a corrupted/cyclic tree can never hang a request
    const folder = await db.fileFolder.findFirst({
      where: { id: cursor, ownerId, trashedAt: null },
      select: { id: true, name: true, parentId: true },
    });
    if (!folder) break;
    chain.push(folder);
    cursor = folder.parentId;
    depth += 1;
  }
  return chain.reverse();
}

/** Folder chain WITHOUT the owner filter — used for cross-owner inheritance walks. */
async function folderChainAny(folderId: string): Promise<(FolderChainNode & { ownerId: string })[]> {
  const chain: (FolderChainNode & { ownerId: string })[] = [];
  let cursor: string | null = folderId;
  let depth = 0;
  while (cursor && depth < 64) {
    const folder = await db.fileFolder.findUnique({
      where: { id: cursor },
      select: { id: true, name: true, parentId: true, ownerId: true },
    });
    if (!folder) break;
    chain.push(folder);
    cursor = folder.parentId;
    depth += 1;
  }
  return chain;
}

/** All descendant folder ids (excluding the folder itself) — bounded BFS (§46). */
export async function descendantFolderIds(rootId: string, ownerId: string): Promise<string[]> {
  const found: string[] = [];
  let frontier = [rootId];
  let depth = 0;
  while (frontier.length > 0 && depth < 64 && found.length < 20_000) {
    const children = await db.fileFolder.findMany({
      where: { ownerId, parentId: { in: frontier } },
      select: { id: true },
      take: 5000,
    });
    frontier = children.map((c) => c.id);
    found.push(...frontier);
    depth += 1;
  }
  return found;
}

/** Throws if moving `folderId` under `newParentId` would create a cycle (§7). */
export async function assertNoFolderCycle(folderId: string, newParentId: string | null, ownerId: string): Promise<void> {
  if (!newParentId) return;
  if (newParentId === folderId) throw Errors.badRequest("A folder cannot be moved into itself.");
  const ancestors = await folderChain(newParentId, ownerId);
  if (ancestors.some((f) => f.id === folderId)) {
    throw Errors.badRequest("A folder cannot be moved into one of its own subfolders.");
  }
}

// ─── Object-level authorization (§12/§39 — THE security boundary) ───────────

export type FileAccess = { level: SharePermission; isOwner: boolean };

/** Resolve the caller's access to a folder (throws 404 → avoids existence leaks, §36). */
export async function canAccessFolder(user: { id: string }, folderId: string, need: SharePermission): Promise<FileAccess & { folderId: string }> {
  const folder = await db.fileFolder.findUnique({ where: { id: folderId }, select: { id: true, ownerId: true, trashedAt: true } });
  if (!folder) throw Errors.notFound("Folder not found.");
  if (folder.ownerId === user.id) {
    if (folder.trashedAt && need !== "VIEW") throw Errors.notFound("Folder not found.");
    return { level: "MANAGE", isOwner: true, folderId };
  }
  // Inherited grants: the folder itself OR any of its ancestors (§15).
  const chain = await folderChainAny(folderId);
  const direct = await activeGrants("FOLDER", chain.map((f) => f.id), user.id);
  // Prefer the DEEPEST applicable grant (most specific wins).
  let best: SharePermission | null = null;
  for (const f of [...chain].reverse()) {
    const perm = direct.get(f.id);
    if (perm && (!best || PERM_RANK[perm] > PERM_RANK[best])) best = perm;
  }
  if (best && satisfies(best, need)) return { level: best, isOwner: false, folderId };
  // Known-but-insufficient → 403 (the resource is visible to the caller);
  // no access at all → 404 (existence hidden, §36).
  if (best) throw Errors.forbidden(`Insufficient permission — this requires ${need}.`);
  throw Errors.notFound("Folder not found.");
}

/** Resolve the caller's access to a file (throws 404 → avoids existence leaks). */
export async function canAccessFile(user: { id: string }, fileId: string, need: SharePermission): Promise<FileAccess & { fileId: string }> {
  const file = await db.fileEntry.findUnique({
    where: { id: fileId },
    select: { id: true, ownerId: true, folderId: true, trashedAt: true },
  });
  if (!file) throw Errors.notFound("File not found.");
  if (file.ownerId === user.id) {
    if (file.trashedAt && need !== "VIEW") throw Errors.notFound("File not found.");
    return { level: "MANAGE", isOwner: true, fileId };
  }
  // Direct file grant (§13) + inherited folder grants (§15) — best wins.
  let best: SharePermission | null = null;
  const direct = await activeGrants("FILE", [fileId], user.id);
  const perm = direct.get(fileId);
  if (perm) best = perm;
  if (file.folderId) {
    const chain = await folderChainAny(file.folderId);
    const inherited = await activeGrants("FOLDER", chain.map((f) => f.id), user.id);
    for (const f of [...chain].reverse()) {
      const p = inherited.get(f.id);
      if (p && (!best || PERM_RANK[p] > PERM_RANK[best])) best = p;
    }
  }
  if (best && satisfies(best, need)) return { level: best, isOwner: false, fileId };
  if (best) throw Errors.forbidden(`Insufficient permission — this requires ${need}.`);
  throw Errors.notFound("File not found.");
}

/** All user ids that currently hold an active grant on the target (for realtime fan-out). */
export async function grantHolderIds(targetType: ShareTargetType, targetId: string): Promise<string[]> {
  const rows = await db.fileShare.findMany({
    where: { targetType, targetId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { sharedWithId: true },
  });
  return rows.map((r) => r.sharedWithId);
}

/** Realtime fan-out for Files mutations (§28) — targeted rooms only. */
export async function emitFilesUpdated(userIds: (string | null | undefined)[], resourceType: string, resourceId: string): Promise<void> {
  const unique = [...new Set(userIds.filter((v): v is string => Boolean(v)))];
  if (unique.length === 0) return;
  await emit({
    type: EVENT_TYPES.FILES_UPDATED,
    resourceType,
    resourceId,
    payload: { userIds: unique },
    actorType: "USER",
  });
}

// ─── Filename / MIME / checksum hardening (§36) ─────────────────────────────

const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** Server-side filename sanitization — client names are never trusted (§36). */
export function sanitizeFileName(raw: string): string {
  let name = String(raw ?? "").split(/[/\\]/).pop() ?? ""; // strip any path components
  name = name.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim().replace(/^[.\s]+/, "");
  if (!name) name = "file";
  if (name.length > 255) {
    const ext = name.slice(name.lastIndexOf(".")).slice(0, 12);
    name = name.slice(0, 255 - ext.length) + ext;
  }
  return name;
}

export function sanitizeFolderName(raw: string): string {
  const name = String(raw ?? "").replace(/[/\\]/g, " ").replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  if (!name) throw Errors.badRequest("Folder name is required.");
  if (name.length > 120) throw Errors.badRequest("Folder name is too long (max 120 characters).");
  return name;
}

export function extOf(name: string): string {
  const m = /\.[A-Za-z0-9]{1,12}$/.exec(name);
  return m ? m[0].slice(1).toLowerCase() : "bin";
}

/** Magic-byte sniffing — the client-provided MIME type is never trusted (§36). */
export function sniffMimeType(buf: Buffer, name: string): string {
  const ext = extOf(name);
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.length >= 3 && buf.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1").toLowerCase();
    if (brand.startsWith("m4a")) return "audio/mp4";
    return "video/mp4";
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString("hex") === "1a45dfa3") return "video/webm";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "OggS") return "audio/ogg";
  if (buf.length >= 3 && (buf.subarray(0, 3).toString("latin1") === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return "audio/mpeg";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "RIFF") return "video/x-msvideo";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("hex") === "504b0304") {
    // ZIP container — docx/xlsx/pptx are ZIPs too
    if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (ext === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return "application/zip";
  }
  if (buf.length >= 2 && buf.subarray(0, 2).toString("hex") === "1f8b") return "application/gzip";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "Rar!") return "application/vnd.rar";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("hex") === "377abcaf271c") return "application/x-7z-compressed";
  // Plain-text family (no NUL bytes in the first 4 KB)
  if (buf.subarray(0, Math.min(4096, buf.length)).includes(0) === false) {
    if (ext === "csv") return "text/csv";
    if (ext === "json") return "application/json";
    if (ext === "html" || ext === "htm") return "text/html";
    return "text/plain";
  }
  return "application/octet-stream";
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ─── Object keys (server-generated; client names never become keys) ─────────

export function fileObjectKey(ownerId: string, fileId: string, version: number, ext: string): string {
  return `files/${ownerId}/${fileId}/v${version}-${randomUUID()}.${ext}`;
}

export function chunkObjectKey(sessionId: string, index: number): string {
  return `uploads-tmp/${sessionId}/${String(index).padStart(6, "0")}`;
}

// ─── Quotas (§29 — server-authoritative, never browser-computed) ────────────

export const QUOTA_SETTING_KEY = "files_user_quota_mb";
const DEFAULT_QUOTA_MB = 512;
const MB = 1024 * 1024;

export async function userQuotaMb(): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: QUOTA_SETTING_KEY }, select: { value: true } }).catch(() => null);
  const mb = Number.parseInt(row?.value ?? "", 10);
  return Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_QUOTA_MB;
}

export async function userQuotaBytes(): Promise<number> {
  return (await userQuotaMb()) * MB;
}

export async function usedBytes(ownerId: string): Promise<number> {
  const agg = await db.fileEntry.aggregate({
    where: { ownerId, trashedAt: null },
    _sum: { sizeBytes: true },
  });
  return agg._sum.sizeBytes ?? 0;
}

export async function assertQuota(ownerId: string, incomingBytes: number): Promise<void> {
  const [quota, used] = await Promise.all([userQuotaBytes(), usedBytes(ownerId)]);
  if (used + incomingBytes > quota) {
    throw Errors.badRequest(
      `Storage quota exceeded — used ${(used / MB).toFixed(1)} MB of ${(quota / MB).toFixed(0)} MB; this upload needs ${(incomingBytes / MB).toFixed(1)} MB. Remove files or ask an administrator to raise the quota.`,
    );
  }
}

// ─── Upload limits (§8/§36) ─────────────────────────────────────────────────

export const MB_BYTES = MB;
export const MAX_CHUNK_BYTES = 8 * MB;
export const MAX_SINGLE_SHOT_BYTES = 25 * MB; // multipart endpoints (versions)
export const MAX_SESSION_BYTES = 200 * MB; // chunked session total
export const MAX_TOTAL_CHUNKS = 200;

// Preview allowlist (§21) — html/svg are NEVER previewable inline (XSS §36);
// they download as attachments instead.
const PREVIEWABLE = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/mp4", "text/plain", "text/csv", "application/json",
]);

export function isPreviewable(mimeType: string): boolean {
  return PREVIEWABLE.has(mimeType);
}

/** Content-Disposition type — anything not on the preview allowlist downloads. */
export function dispositionFor(mimeType: string): "inline" | "attachment" {
  return isPreviewable(mimeType) ? "inline" : "attachment";
}

// ─── Malware scanning hook (§37 — honest: no ClamAV in this deployment) ─────
// The upload pipeline calls this BEFORE an object is committed. When a scanner
// becomes available, implement the check here (quarantine → scan → clean);
// until then it reports scanned:false — the UI never claims scanning is active.

export type ScanResult = { scanned: boolean; clean: boolean; engine: string; detail?: string };

export async function scanUpload(_buf: Buffer, _name: string): Promise<ScanResult> {
  return { scanned: false, clean: true, engine: "none", detail: "No malware scanner is configured in this deployment." };
}

// ─── Route helper: forward Next.js dynamic params into handler() ────────────
// handler() wraps only (req) — dynamic routes need params. This mirrors the
// house withId() pattern in one place for the whole Files module.

import type { NextRequest } from "next/server";
import { handler } from "@/lib/hms/api";

export function withParams<P extends Record<string, string>>(
  fn: (ctx: { req: NextRequest; requestId: string; user: { id: string; email: string; name: string; role: string }; params: P }) => Promise<Response> | Response,
  opts?: { permission?: Permission; auth?: boolean },
) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) =>
    handler(async (c) => fn({ ...c, params: await ctx.params }), opts)(req);
}
