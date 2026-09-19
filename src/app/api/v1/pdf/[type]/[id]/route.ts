// MOHD.HMS ENTERPRISE — Central PDF download endpoint.
//
//   GET /api/v1/pdf/{type}/{id}            → application/pdf (attachment)
//   GET /api/v1/pdf/{type}/{id}?disposition=inline → application/pdf (inline preview)
//
// The route is intentionally THIN: authentication + RBAC + dispatch through the
// centralized document registry (§5/§6). No rendering code lives here.
//
// Contract (§7): authenticate → check document permission → verify record
// exists → enforce customer scoping → load authoritative DB data → generate →
// validate → return binary PDF with correct headers → log the result.
//
// Failures NEVER return HTTP 200 (§36): validation or generation errors raise
// a structured PDF_GENERATION_FAILED error; only SUPER_ADMIN receives technical
// diagnostics (handled centrally by the handler() error pipeline).

import { NextResponse } from "next/server";
import { handler, Errors, ApiError } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { findDocumentType, buildDocument } from "@/lib/hms/pdf/documents";
import { PdfGenerationError } from "@/lib/hms/pdf/engine";

export const runtime = "nodejs"; // filesystem (logo) + pdf-lib

export const GET = handler(
  async ({ req, requestId, user }) => {
    // /api/v1/pdf/{type}/{id} — parsed from the path (handler wraps req only).
    const segs = new URL(req.url).pathname.split("/").filter(Boolean);
    const type = segs[3] ?? "";
    const id = segs[4] ?? "";

    const def = findDocumentType(type);
    if (!def || !id) throw Errors.notFound("Unknown document type.");

    // §21 — every document enforces its module's read permission. Documents may
    // declare extraPermissions (e.g. customers with irms.portal may download
    // their own shared/approved inspection reports — the loader still scopes).
    const permitted =
      roleCan(user.role, def.permission) ||
      (def.extraPermissions ?? []).some((p) => roleCan(user.role, p));
    if (!permitted) throw Errors.forbidden();

    const started = Date.now();
    try {
      // Forward the request origin (x-forwarded-proto/host) so IRMS documents
      // can embed the same absolute QR URL as the QR endpoint (contract §17).
      const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
      const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host")?.trim();
      const origin = host ? `${proto || "http"}://${host}` : undefined;
      const doc = await buildDocument(def, id, user, undefined, origin);
      const durationMs = Date.now() - started;

      // §35 — structured generation log (no sensitive data).
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          requestId,
          route: `/api/v1/pdf/${type}/${id}`,
          msg: "pdf.generated",
          docType: type,
          docNumber: doc.docNumber,
          userId: user.id,
          durationMs,
          bytes: doc.bytes.length,
          pageCount: doc.pageCount,
        })
      );

      // §8 — real binary PDF with correct headers.
      const disposition = req.nextUrl.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
      return new NextResponse(Buffer.from(doc.bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `${disposition}; filename="${doc.filename}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
          "Content-Length": String(doc.bytes.length),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof ApiError && err.status < 500) throw err; // 401/403/404 pass through

      // §20/§35 — generation failures are logged, then surfaced as a
      // structured error; SUPER_ADMIN diagnostics attached centrally.
      const detail = err instanceof PdfGenerationError ? err.detail : err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          requestId,
          route: `/api/v1/pdf/${type}/${id}`,
          msg: "pdf.generation_failed",
          docType: type,
          userId: user.id,
          durationMs,
          detail,
        })
      );
      throw new ApiError(500, "PDF_GENERATION_FAILED", "The document could not be generated. Please try again or contact support.", { detail });
    }
  },
  { auth: true } // permission is per-document-type, enforced inside
);
