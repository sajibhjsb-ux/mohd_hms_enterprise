// MOHD.HMS ENTERPRISE — Letter PDF endpoint (§25/§26/§28/§37).
//
//   GET /api/v1/hr/letters/{id}/pdf[?disposition=inline]
//
// FINALIZED+ letters stream the IMMUTABLE stored object from S3/MinIO (§28 —
// a historical final document never changes). Drafts render an on-demand,
// clearly-not-final copy for review (never persisted).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { storage } from "@/lib/hms/storage";
import { buildLetterPdf, letterPdfKey } from "@/lib/hms/letters/pdf";
import { audit } from "@/lib/hms/services";

export const runtime = "nodejs";

export const GET = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const inline = new URL(req.url).searchParams.get("disposition") === "inline";

    const letter = await db.letter.findUnique({ where: { id } });
    if (!letter) throw Errors.notFound("Letter not found.");

    // ── Finalized: the immutable stored object (§28) ────────────────────────
    if (letter.pdfObjectKey) {
      const obj = await storage.get(letter.pdfObjectKey);
      if (!obj) throw Errors.notFound("The finalized PDF could not be found in storage.");
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "LETTER_DOWNLOADED",
        resourceType: "LETTER",
        resourceId: letter.id,
        metadata: { letterNumber: letter.letterNumber, key: letter.pdfObjectKey },
      });
      await db.letterEvent.create({
        data: { letterId: letter.id, action: "DOWNLOADED", detail: `Final PDF ${inline ? "previewed" : "downloaded"}`, actorId: user.id, actorName: user.name },
      }).catch(() => {});
      return new NextResponse(new Uint8Array(obj.buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(obj.buffer.length),
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="MOHD-HMS-Letter-${letter.letterNumber.replace(/\//g, "-")}.pdf"`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    // ── Draft: on-demand review copy (never stored, never sent) ─────────────
    if (!["DRAFT", "AI_GENERATED", "REJECTED", "UNDER_REVIEW", "APPROVED"].includes(letter.status)) {
      throw Errors.badRequest("This letter has no final document.");
    }
    const full = await db.letter.findUniqueOrThrow({ where: { id } });
    const { bytes, filename } = await buildLetterPdf(full);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  },
  { permission: PERMISSIONS.letters_view }
);
