// MOHD.HMS ENTERPRISE — internal QR status endpoint (ch.35 §29/§37/§38/§40/§52).
// GET /api/v1/qr/{entityType}/{entityId} → current canonical identity + QR
// image data URL for the entity's own detail page. POST = explicit first-time
// generation. RBAC rides the owning module's EXISTING permissions (§52 — no
// new permission architecture). Responses use the central ok() envelope.

import { NextRequest } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { db } from "@/lib/db";
import {
  ensureQr, getActiveQr, readPermissionFor, managePermissionFor,
  verificationUrl, qrDataUrl, requestOrigin, type QrEntityType,
} from "@/lib/hms/qr/service";

type QrView = {
  qr: {
    id: string;
    status: string;
    verificationUrl: string;
    issuedAt: Date;
    expiresAt: Date | null;
    verifyCount: number;
    lastVerifiedAt: Date | null;
    dataUrl?: string;
  } | null;
  lastRevoked: { id: string; revokedAt: Date | null; revokedReason: string } | null;
  canManage: boolean;
  entityType: string;
};

export const GET = async (req: NextRequest, ctx: { params: Promise<{ entityType: string; entityId: string }> }) => {
  const { entityType, entityId } = await ctx.params;
  const permission = readPermissionFor(entityType);
  if (!permission) throw Errors.notFound("Unknown QR entity type.");

  return handler(
    async ({ req: request, user }) => {
      // READ-ONLY view: the panel shows ACTIVE / REVOKED (last identity) /
      // NOT GENERATED; creation is an explicit MANAGE action (§29/§30).
      const [qr, lastRevoked] = await Promise.all([
        getActiveQr(entityType as QrEntityType, entityId),
        db.qrCode.findFirst({
          where: { entityType, entityId, status: "REVOKED" },
          orderBy: { revokedAt: "desc" },
          select: { id: true, revokedAt: true, revokedReason: true },
        }),
      ]);
      const canManage = roleCan(user.role, managePermissionFor(entityType) ?? permission);

      if (!qr) {
        return ok<QrView>({ qr: null, lastRevoked: lastRevoked ?? null, canManage, entityType });
      }

      const url = await verificationUrl(qr.publicToken, requestOrigin(request));
      const dataUrl = await qrDataUrl(url, 256);
      return ok<QrView>({
        qr: {
          id: qr.id,
          status: qr.status,
          verificationUrl: url,
          issuedAt: qr.issuedAt,
          expiresAt: qr.expiresAt,
          verifyCount: qr.verifyCount,
          lastVerifiedAt: qr.lastVerifiedAt,
          dataUrl,
        },
        lastRevoked: lastRevoked ?? null,
        canManage,
        entityType,
      });
    },
    { permission }
  )(req);
};

/** POST = explicit first-time creation (§29 "Generate") — a MANAGE action. */
export const POST = async (req: NextRequest, ctx: { params: Promise<{ entityType: string; entityId: string }> }) => {
  const { entityType, entityId } = await ctx.params;
  const manage = managePermissionFor(entityType);
  if (!manage) throw Errors.notFound("Unknown QR entity type.");

  return handler(
    async ({ req: request, user }) => {
      const qr = await ensureQr(entityType as QrEntityType, entityId, {
        verificationType: entityType === "EQUIPMENT" ? "EQUIPMENT" : "DOCUMENT",
        issuedById: user.id,
        auditContext: "ui-generate",
      });
      if (!qr) throw Errors.internal("QR generation failed.");
      const url = await verificationUrl(qr.publicToken, requestOrigin(request));
      const dataUrl = await qrDataUrl(url, 256);
      return ok<QrView>({
        qr: {
          id: qr.id,
          status: qr.status,
          verificationUrl: url,
          issuedAt: qr.issuedAt,
          expiresAt: qr.expiresAt,
          verifyCount: qr.verifyCount,
          lastVerifiedAt: qr.lastVerifiedAt,
          dataUrl,
        },
        lastRevoked: null,
        canManage: true,
        entityType,
      });
    },
    { permission: manage }
  )(req);
};
