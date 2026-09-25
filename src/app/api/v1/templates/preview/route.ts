// MOHD.HMS ENTERPRISE — Template preview (Settings → Templates editor).
//
//   POST /api/v1/templates/preview   { templateType, layout, style }
//   → application/pdf (inline, sample dataset)
//
// §33/§34/§47 — the preview renders a realistic SAMPLE dataset through the
// SAME block renderers + PdfDoc engine used in production (NO fake HTML
// preview, NO second renderer). Business records are never touched; the
// sample QR encodes an honest explanatory string (no fake token is minted).
//
// Rate limited per user (in-memory; previews are full PDF builds) and
// additionally cached per (type+layout+style) hash for 60s so dragging a
// slider or toggling a heading doesn't rebuild identical PDFs.

import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler, Errors, parseBody, ApiError } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { sanitizeLayout, TEMPLATE_TYPES, type TemplateType } from "@/lib/hms/pdf/template-meta";
import { sanitizeStyle } from "@/lib/hms/pdf/template-style";

const bodySchema = z.object({
  templateType: z.string().min(1),
  layout: z.unknown().optional(),
  style: z.unknown().optional(),
});

// Small in-memory response cache (sandbox has no Redis; 4GB box — bounded).
type CacheEntry = { bytes: Buffer; pageCount: number; expiresAt: number };
const PREVIEW_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 24;

// In-memory rate limit: 20 previews per minute per user (previews are full builds).
const buckets = new Map<string, { count: number; resetAt: number }>();

export const runtime = "nodejs"; // pdf-lib + filesystem (logo)

export const POST = handler(
  async ({ req, user, requestId }) => {
    // Rate limit (per user; the preview is a full PDF build).
    const key = `tpl-preview:${user.id}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
    } else {
      bucket.count += 1;
      if (bucket.count > 20) {
        throw new ApiError(429, "RATE_LIMITED", "Too many previews. Please wait a moment and try again.");
      }
    }

    const body = await parseBody(req, bodySchema);
    if (!(TEMPLATE_TYPES as readonly string[]).includes(body.templateType)) {
      throw Errors.badRequest("Unknown document type.");
    }
    const type = body.templateType as TemplateType;
    // Sanitize on the server too — the client editor is not trusted (§46).
    const layout = sanitizeLayout(body.layout, type);
    const style = sanitizeStyle(body.style);

    // 60s cache keyed by the SANITIZED config (identical edits skip the rebuild).
    const hash = createHash("sha256")
      .update(type)
      .update(JSON.stringify(layout))
      .update(JSON.stringify(style))
      .digest("hex")
      .slice(0, 24);
    const cached = PREVIEW_CACHE.get(hash);
    if (cached && cached.expiresAt > now) {
      return pdfResponse(cached.bytes, cached.pageCount);
    }

    const { buildSampleDocument } = await import("@/lib/hms/pdf/documents");
    const started = Date.now();
    const doc = await buildSampleDocument(type, layout, style);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        requestId,
        route: "/api/v1/templates/preview",
        msg: "template.preview_built",
        docType: type,
        userId: user.id,
        durationMs: Date.now() - started,
        pageCount: doc.pageCount,
        cached: false,
      })
    );

    if (PREVIEW_CACHE.size >= CACHE_MAX) {
      const oldest = PREVIEW_CACHE.keys().next().value;
      if (oldest) PREVIEW_CACHE.delete(oldest);
    }
    PREVIEW_CACHE.set(hash, { bytes: Buffer.from(doc.bytes), pageCount: doc.pageCount, expiresAt: now + CACHE_TTL_MS });
    return pdfResponse(new Uint8Array(doc.bytes), doc.pageCount);
  },
  { permission: PERMISSIONS.templates_read }
);

function pdfResponse(bytes: Uint8Array, pageCount: number): NextResponse {
  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline",
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Page-Count": String(pageCount),
    },
  });
}
