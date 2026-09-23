// MOHD.HMS ENTERPRISE — PUBLIC online verification endpoint (ch.35 spec §5/§6/
// §27/§28/§54/§62). This is the endpoint every QR code in the system points
// to. It requires NO authentication when the record is intentionally publicly
// verifiable — verification is the product (§37).
//
// Security: rate limited per IP (anti-abuse/enumeration §27), token validated
// + HMAC-checked + status-validated against the authoritative PostgreSQL
// record before any "verified" claim (§36/§62), safe whitelisted DTO output
// only (§63), no stack traces (§56), every attempt audited (§28).

import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/hms/qr/service";
import { loadPublicVerification } from "@/lib/hms/qr/verifiers";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { db } from "@/lib/db";
import crypto from "crypto";

export const runtime = "nodejs";

/** Privacy-conscious request context (§28): short IP hash (not reversible),
 *  bounded UA snippet — no raw addresses stored. */
function requestContext(req: NextRequest): string {
  const ip = clientIp(req) || "unknown";
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 10);
  const ua = (req.headers.get("user-agent") || "").replace(/\s+/g, " ").slice(0, 60);
  return `${ipHash}:${ua}`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // §27 — abuse protection / rate limiting FIRST (20 verifications per
  // minute per IP is far above any honest scanning pattern).
  const ip = clientIp(req) || "unknown";
  const limited = rateLimit(`qr-verify:${ip}`, 20, 60_000);
  if (!limited.allowed) {
    try {
      await db.qrVerificationLog.create({
        data: { result: "RATE_LIMITED", requestContext: requestContext(req) },
      });
    } catch {
      /* logging must never break the response */
    }
    return NextResponse.json(
      { ok: false, error: "RATE_LIMITED", message: "Too many verification attempts. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec), "Cache-Control": "no-store" } }
    );
  }

  const outcome = await verifyToken(token, { requestContext: requestContext(req) });

  // §62 — never cache a verification result: every scan must hit the live
  // backend. no-store also applies to intermediaries.
  const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

  if (outcome.result === "VERIFIED" && outcome.entity) {
    return NextResponse.json(
      {
        ok: true,
        verification: {
          result: "VERIFIED",
          entityType: outcome.qr?.entityType,
          label: outcome.entity.label,
          number: outcome.entity.number,
          numberLabel: outcome.entity.numberLabel,
          recordStatus: outcome.entity.recordStatus,
          statusLabel: outcome.entity.statusLabel,
          fields: outcome.entity.fields,
          verifiedAt: new Date().toISOString(),
          access: outcome.entity.access,
        },
      },
      { status: 200, headers: noStore }
    );
  }

  // Non-verified outcomes. For lifecycle states (§31) the page may show the
  // document reference — resolved through the SAME safe whitelist DTO, and
  // only when the underlying record is itself publicly presentable.
  if (
    (outcome.result === "REVOKED" || outcome.result === "EXPIRED" || outcome.result === "CANCELLED" || outcome.result === "SUPERSEDED") &&
    outcome.qr
  ) {
    const entity = await loadPublicVerification(outcome.qr.entityType, outcome.qr.entityId);
    const presentable = entity && !entity.restricted ? entity : null;
    return NextResponse.json(
      {
        ok: true,
        verification: {
          result: outcome.result,
          entityType: outcome.qr.entityType,
          label: presentable?.label,
          number: presentable?.number,
          numberLabel: presentable?.numberLabel,
          statusLabel: presentable?.statusLabel,
          fields: presentable?.fields ?? [],
          revokedReason: outcome.qr.revokedReason || undefined,
          verifiedAt: new Date().toISOString(),
          access: null,
        },
      },
      { status: 200, headers: noStore }
    );
  }

  if (outcome.result === "RESTRICTED") {
    return NextResponse.json(
      {
        ok: true,
        verification: {
          result: "RESTRICTED",
          message: "This record is not available for public verification.",
          verifiedAt: new Date().toISOString(),
        },
      },
      { status: 200, headers: noStore }
    );
  }

  // NOT_FOUND | INVALID_TOKEN | INVALID_SIGNATURE — identical response body
  // for all three (no enumeration signal beyond the generic invalid state).
  return NextResponse.json(
    {
      ok: true,
      verification: {
        result: outcome.httpStatus === 500 ? "ERROR" : "INVALID",
        message: "This QR code could not be verified.",
        verifiedAt: new Date().toISOString(),
      },
    },
    { status: outcome.httpStatus === 500 ? 500 : 200, headers: noStore }
  );
}
