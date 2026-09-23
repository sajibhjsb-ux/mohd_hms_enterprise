// MOHD.HMS ENTERPRISE — Central QR Service (ch.35 spec §3/§9/§12/§31/§33/§36).
//
// THE one QR engine for the whole application: identity creation, token
// generation, signing, verification, revocation, regeneration, status
// management, audit logging and image rendering. Equipment, invoices,
// quotations, work orders, complaints, inspection reports, payments, POs and
// PM tasks all consume THIS service — no module ever implements QR logic
// itself (§67: one central service + one verification engine).
//
// Security posture:
//   §8  — QR payloads contain ONLY an opaque verification URL. No business
//         data (customer names, amounts, emails, addresses) ever enters a QR.
//   §9  — every identity is HMAC-SHA256-signed over a canonical payload with
//         a server-only secret (approved Node crypto, no custom primitives,
//         secrets never reach the frontend).
//   §12 — ONE canonical ACTIVE identity per record; opening a record never
//         rotates the token. Regeneration is an explicit, audited action.
//   §31 — old tokens stay as REVOKED rows: a printed label always resolves
//         honestly ("revoked"), never to a different record.
//   §33 — PDF regeneration reuses the same identity (ensureQr is idempotent).
//   §36 — "QR exists" ≠ "verified": verification validates token → signature
//         → expiry → record → document status before returning VERIFIED.
//   §47 — verification URLs derive from the configured public origin
//         (Settings → public website) so they work outside the LAN.

import "server-only";
import crypto from "crypto";
import QRCode from "qrcode";
import type { Permission } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";

// ── entity types (§11 — open registry; new types need no redesign) ─────────

export const QR_ENTITY_TYPES = [
  "EQUIPMENT",
  "INVOICE",
  "QUOTATION",
  "WORK_ORDER",
  "COMPLAINT",
  "INSPECTION_REPORT",
  "PAYMENT_RECEIPT",
  "PURCHASE_ORDER",
  "PM_TASK",
] as const;
export type QrEntityType = (typeof QR_ENTITY_TYPES)[number] | (string & {});

// ── verification results (§7 — deterministic, distinguishable states) ──────

export type QrVerifyResult =
  | "VERIFIED"
  | "REVOKED"
  | "EXPIRED"
  | "CANCELLED"
  | "SUPERSEDED"
  | "RESTRICTED"
  | "NOT_FOUND"
  | "INVALID_TOKEN"
  | "INVALID_SIGNATURE"
  | "ERROR";

// ── cryptographic identity (§8/§9) ──────────────────────────────────────────

const TOKEN_BYTES = 24; // → 32 url-safe chars: unguessable, enumeration-proof

/** Server-only signing secret — same trusted chain pattern as the approved
 *  AES/HOTP crypto in email/crypto.ts. Never leaves the backend. */
function signingSecret(): string {
  return (
    process.env.QR_SIGNING_SECRET ||
    process.env.EMAIL_CRYPTO_SECRET ||
    process.env.OTP_HASH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "mohd-hms-dev-only-fallback-secret"
  );
}

/** Canonical signed payload (§9): document_id, type, qr_id, token, version,
 *  issued_at. Any printed/decoded value can be re-checked offline of business
 *  data but only ONLINE verification decides validity (§48). */
function canonicalPayload(q: {
  id: string;
  publicToken: string;
  entityType: string;
  entityId: string;
  documentVersion: number;
  issuedAt: Date;
}): string {
  return [
    "qr-v1",
    q.id,
    q.publicToken,
    q.entityType,
    q.entityId,
    `v${q.documentVersion}`,
    q.issuedAt.toISOString(),
  ].join("|");
}

function signPayload(payload: string): string {
  return crypto.createHmac("sha256", signingSecret()).update(payload).digest("hex");
}

/** Constant-time signature comparison — never early-exit on length. */
function signaturesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Opaque public token: cryptographically random, url-safe (§8). */
function newPublicToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Cheap shape gate BEFORE any DB lookup — kills enumeration noise. */
export function isPlausibleToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{24,64}$/.test(token);
}

// ── public verification base URL (§46/§47) ─────────────────────────────────

/** ONE place resolves the verification origin: 1) the admin-configured public
 *  website (Settings → public_url — the same origin the app already uses for
 *  canonical legal URLs), 2) an env-configured public origin, 3) the incoming
 *  request origin (behind Cloudflare Tunnel/Nginx: x-forwarded-*). Never a
 *  private LAN address hardcoded anywhere. */
export async function verificationBaseUrl(reqOrigin?: string): Promise<string> {
  try {
    const row = await db.setting.findUnique({ where: { key: "public_url" }, select: { value: true } });
    if (row?.value && /^https?:\/\//.test(row.value)) return row.value.replace(/\/+$/, "");
  } catch {
    // optional setting — never fail identity creation for it
  }
  const envUrl = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (envUrl && /^https?:\/\//.test(envUrl)) return envUrl.replace(/\/+$/, "");
  return (reqOrigin || "http://localhost:3000").replace(/\/+$/, "");
}

export async function verificationUrl(publicToken: string, reqOrigin?: string): Promise<string> {
  const base = await verificationBaseUrl(reqOrigin);
  return `${base}/verify/${publicToken}`;
}

/** Resolve the request's public origin behind Cloudflare Tunnel/Nginx
 *  (x-forwarded-*) with a localhost:3000 fallback for direct dev access. */
export function requestOrigin(req: Request): string {
  const h = req.headers;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host")?.trim();
  if (host) return `${proto || "http"}://${host}`;
  return "http://localhost:3000";
}

// ── QR image rendering (§43/§44 — production-grade, print-safe) ────────────

/** High error correction (H), quiet zone ≥ 2 modules, maximum contrast —
 *  survives A4 printing, office compression, grayscale and photocopying. */
export async function qrPngBuffer(url: string, size = 512): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: "png",
    width: size,
    margin: 2,
    errorCorrectionLevel: "H",
    color: { dark: "#101815ff", light: "#ffffffff" },
  });
}

export async function qrDataUrl(url: string, size = 256): Promise<string> {
  return QRCode.toDataURL(url, {
    width: size,
    margin: 2,
    errorCorrectionLevel: "H",
    color: { dark: "#101815ff", light: "#ffffffff" },
  });
}

// ── identity lifecycle (§12/§30/§31/§59/§60) ───────────────────────────────

export type QrCodeRow = {
  id: string;
  publicToken: string;
  entityType: string;
  entityId: string;
  documentVersion: number;
  verificationType: string;
  status: string;
  issuedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string;
  verifyCount: number;
  lastVerifiedAt: Date | null;
};

export type EnsureQrOptions = {
  verificationType?: "DOCUMENT" | "EQUIPMENT";
  expiresAt?: Date | null;
  issuedById?: string | null;
  /** context label for the audit trail when creation is system-initiated */
  auditContext?: string;
};

/** Get-or-create THE canonical ACTIVE identity for a record. Idempotent:
 *  calling it on every page open / PDF regeneration NEVER rotates the token
 *  (§12/§33). Purely an infrastructure operation — never mutates business
 *  data (§59). Returns null only if persistence fails (callers degrade
 *  honestly instead of failing the business operation). */
export async function ensureQr(
  entityType: QrEntityType,
  entityId: string,
  opts: EnsureQrOptions = {}
): Promise<QrCodeRow | null> {
  try {
    const existing = await db.qrCode.findFirst({
      where: { entityType, entityId, status: "ACTIVE" },
      orderBy: { issuedAt: "desc" },
    });
    if (existing) return shape(existing);

    const issuedAt = new Date();
    const created = await db.qrCode.create({
      data: {
        publicToken: newPublicToken(),
        entityType,
        entityId,
        documentVersion: 1,
        verificationType: opts.verificationType ?? "DOCUMENT",
        status: "ACTIVE",
        issuedAt,
        expiresAt: opts.expiresAt ?? null,
        createdById: opts.issuedById ?? null,
      },
    });
    // attach the signature (canonical payload includes the row id)
    const signature = signPayload(canonicalPayload(created));
    const signed = await db.qrCode.update({ where: { id: created.id }, data: { signature } });

    await audit({
      actorId: opts.issuedById ?? null,
      action: "QR_CREATED",
      resourceType: "QrCode",
      resourceId: created.id,
      metadata: { entityType, entityId, context: opts.auditContext ?? "explicit", publicTokenPrefix: created.publicToken.slice(0, 6) },
    });
    return shape(signed);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "qr.ensure_failed", entityType, entityId, err: String(err) }));
    return null;
  }
}

/** Explicit, authorized regeneration (§30): revoke the current identity and
 *  issue a fresh one in one transaction. The OLD token becomes a REVOKED row
 *  — printed labels show "revoked", never a wrong record. */
export async function regenerateQr(
  entityType: QrEntityType,
  entityId: string,
  actor: { id: string; email: string }
): Promise<QrCodeRow> {
  const result = await db.$transaction(async (tx) => {
    await tx.qrCode.updateMany({
      where: { entityType, entityId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date(), revokedReason: "Regenerated — replaced by a new QR identity" },
    });
    const issuedAt = new Date();
    const created = await tx.qrCode.create({
      data: {
        publicToken: newPublicToken(),
        entityType,
        entityId,
        verificationType: entityType === "EQUIPMENT" ? "EQUIPMENT" : "DOCUMENT",
        status: "ACTIVE",
        issuedAt,
        createdById: actor.id,
      },
    });
    return tx.qrCode.update({ where: { id: created.id }, data: { signature: signPayload(canonicalPayload(created)) } });
  });

  await audit({ actorId: actor.id, actorEmail: actor.email, action: "QR_REGENERATED", resourceType: "QrCode", resourceId: result.id, metadata: { entityType, entityId, oldIdentityRevoked: true } });
  return shape(result);
}

/** Authorized revocation (§31) with a required business reason. */
export async function revokeQr(
  qrId: string,
  actor: { id: string; email: string },
  reason: string
): Promise<QrCodeRow> {
  const updated = await db.qrCode.update({
    where: { id: qrId },
    data: { status: "REVOKED", revokedAt: new Date(), revokedById: actor.id, revokedReason: reason.slice(0, 300) },
  });
  await audit({ actorId: actor.id, actorEmail: actor.email, action: "QR_REVOKED", resourceType: "QrCode", resourceId: qrId, metadata: { entityType: updated.entityType, entityId: updated.entityId, reason: reason.slice(0, 300) } });
  return shape(updated);
}

/** The current ACTIVE identity for a record (or null). */
export async function getActiveQr(entityType: QrEntityType, entityId: string): Promise<QrCodeRow | null> {
  const row = await db.qrCode.findFirst({ where: { entityType, entityId, status: "ACTIVE" }, orderBy: { issuedAt: "desc" } });
  return row ? shape(row) : null;
}

function shape(r: {
  id: string; publicToken: string; entityType: string; entityId: string; documentVersion: number;
  verificationType: string; status: string; issuedAt: Date; expiresAt: Date | null;
  revokedAt: Date | null; revokedReason: string; verifyCount: number; lastVerifiedAt: Date | null;
}): QrCodeRow {
  return {
    id: r.id, publicToken: r.publicToken, entityType: r.entityType, entityId: r.entityId,
    documentVersion: r.documentVersion, verificationType: r.verificationType, status: r.status,
    issuedAt: r.issuedAt, expiresAt: r.expiresAt, revokedAt: r.revokedAt, revokedReason: r.revokedReason,
    verifyCount: r.verifyCount, lastVerifiedAt: r.lastVerifiedAt,
  };
}

// ── verification engine (§5/§7/§36/§62) — the authoritative online check ───

export type VerificationContext = {
  /** short non-reversible IP hash + UA snippet (privacy-conscious §28) */
  requestContext: string;
  userId?: string | null;
};

export type VerificationOutcome = {
  result: QrVerifyResult;
  httpStatus: number;
  /** resolved row only when the token itself is real (revoked/expired pages
   *  may show the reference — §31 — but never secret fields). */
  qr?: QrCodeRow;
  entity?: import("./verifiers").PublicVerification;
};

export async function verifyToken(token: string, ctx: VerificationContext): Promise<VerificationOutcome> {
  const log = async (result: QrVerifyResult, qrCodeId: string | null, entityType = "", entityId = "") => {
    try {
      await db.qrVerificationLog.create({
        data: { qrCodeId, entityType, entityId, result, requestContext: ctx.requestContext.slice(0, 120), userId: ctx.userId ?? null },
      });
      if (result === "VERIFIED" && qrCodeId) {
        await db.qrCode.update({ where: { id: qrCodeId }, data: { verifyCount: { increment: 1 }, lastVerifiedAt: new Date() } });
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "qr.verify_log_failed", result, err: String(err) }));
    }
  };

  try {
    // 1) token shape (§8/§27) — no DB round-trip for garbage/enumeration probes
    if (!isPlausibleToken(token)) {
      await log("INVALID_TOKEN", null);
      return { result: "INVALID_TOKEN", httpStatus: 404 };
    }

    // 2) single indexed lookup (§54)
    const row = await db.qrCode.findUnique({ where: { publicToken: token } });
    if (!row) {
      await log("NOT_FOUND", null);
      return { result: "NOT_FOUND", httpStatus: 404 };
    }

    // 3) signature (§9/§36) — a forged/altered token never resolves
    if (!row.signature || !signaturesMatch(row.signature, signPayload(canonicalPayload(row)))) {
      await log("INVALID_SIGNATURE", row.id, row.entityType, row.entityId);
      return { result: "INVALID_SIGNATURE", httpStatus: 404 };
    }

    // 4) QR lifecycle states
    if (row.status === "REVOKED") {
      await log("REVOKED", row.id, row.entityType, row.entityId);
      return { result: "REVOKED", httpStatus: 200, qr: shape(row) };
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      await log("EXPIRED", row.id, row.entityType, row.entityId);
      return { result: "EXPIRED", httpStatus: 200, qr: shape(row) };
    }

    // 5) resolve the authoritative record + derive the document state (§32)
    const { loadPublicVerification, verifierLabel } = await import("./verifiers");
    const entity = await loadPublicVerification(row.entityType, row.entityId);
    if (!entity) {
      await log("NOT_FOUND", row.id, row.entityType, row.entityId);
      return { result: "NOT_FOUND", httpStatus: 404, qr: shape(row) };
    }
    if (entity.restricted) {
      await log("RESTRICTED", row.id, row.entityType, row.entityId);
      return { result: "RESTRICTED", httpStatus: 200, qr: shape(row) };
    }

    let result: QrVerifyResult = "VERIFIED";
    const s = (entity.recordStatus || "").toUpperCase();
    if (entity.verifyState === "CANCELLED" || /CANCEL|REJECT/.test(s)) result = "CANCELLED";
    else if (entity.verifyState === "SUPERSEDED" || s === "CONVERTED") result = "SUPERSEDED";
    entity.label = verifierLabel(row.entityType);

    await log(result, row.id, row.entityType, row.entityId);
    return { result, httpStatus: 200, qr: shape(row), entity };
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "qr.verify_failed", err: String(err) }));
    await log("ERROR", null).catch(() => {});
    return { result: "NOT_FOUND", httpStatus: 500 };
  }
}

// ── RBAC map (§52 — EXISTING permissions only, no new architecture) ────────

/** Internal QR actions ride the owning module's existing permissions — the
 *  QR system introduces zero new permission kinds (§52). */
export const QR_READ_PERMISSION: Record<string, Permission> = {
  EQUIPMENT: "equipment.read",
  INVOICE: "invoices.read",
  QUOTATION: "quotations.read",
  WORK_ORDER: "work_orders.read",
  COMPLAINT: "complaints.read",
  INSPECTION_REPORT: "irms.read",
  PAYMENT_RECEIPT: "payments.read",
  PURCHASE_ORDER: "purchases.read",
  PM_TASK: "pm.read",
};

export const QR_MANAGE_PERMISSION: Record<string, Permission> = {
  EQUIPMENT: "equipment.update",
  INVOICE: "invoices.manage",
  QUOTATION: "quotations.manage",
  WORK_ORDER: "work_orders.update",
  COMPLAINT: "complaints.update",
  INSPECTION_REPORT: "irms.manage",
  PAYMENT_RECEIPT: "invoices.manage",
  PURCHASE_ORDER: "purchases.manage",
  PM_TASK: "pm.manage",
};

export function readPermissionFor(entityType: string): Permission | null {
  return QR_READ_PERMISSION[entityType] ?? null;
}
export function managePermissionFor(entityType: string): Permission | null {
  return QR_MANAGE_PERMISSION[entityType] ?? null;
}

// ── PDF pipeline bridge (§21/§57/§60/§61/§33) ──────────────────────────────

/** §61 — draft documents are never publicly verifiable. Per-type eligibility
 *  follows the existing business lifecycle (finalized/approved only). */
const PDF_QR_ELIGIBLE: Record<string, (status: string) => boolean> = {
  INVOICE: (s) => s !== "DRAFT",
  QUOTATION: (s) => s !== "DRAFT",
  PURCHASE_ORDER: (s) => s !== "DRAFT",
  INSPECTION_REPORT: (s) => s === "APPROVED" || s === "ARCHIVED",
  WORK_ORDER: () => true,
  COMPLAINT: () => true,
  PAYMENT_RECEIPT: () => true,
  EQUIPMENT: () => true,
  PM_TASK: () => true,
};

export type PdfQrBadge = {
  png: Uint8Array;
  /** document reference printed next to the QR (§22) */
  reference: string;
  url: string;
};

/** THE one hook the central PDFService renderers call (§21: no per-renderer
 *  QR logic). Resolves-or-creates THE canonical identity for the record
 *  (idempotent across PDF regenerations — §33), renders the print-grade QR
 *  image (§43/§44) and returns the badge. Returns null when the record is
 *  not QR-eligible (e.g. drafts §61) or on any failure — the PDF still
 *  generates, honestly without a QR, and the business operation (§59) is
 *  never affected by QR infrastructure problems. */
export async function pdfQrBadge(
  entityType: QrEntityType,
  entityId: string,
  opts: { status?: string; origin?: string; reference?: string }
): Promise<PdfQrBadge | null> {
  try {
    const eligible = PDF_QR_ELIGIBLE[entityType];
    if (eligible && opts.status !== undefined && !eligible(opts.status)) return null;

    const qr = await ensureQr(entityType, entityId, {
      verificationType: entityType === "EQUIPMENT" ? "EQUIPMENT" : "DOCUMENT",
      auditContext: "pdf-build",
    });
    if (!qr) return null;

    const url = await verificationUrl(qr.publicToken, opts.origin);
    const png = await qrPngBuffer(url, 512);
    return { png: new Uint8Array(png), reference: opts.reference || "", url };
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "qr.pdf_badge_failed", entityType, entityId, err: String(err) }));
    return null;
  }
}
