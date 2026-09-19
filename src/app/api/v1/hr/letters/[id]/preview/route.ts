// MOHD.HMS ENTERPRISE — Letter preview endpoint (§26).
//
//   GET /api/v1/hr/letters/{id}/preview → LetterPreviewModel
//
// The SAME rendered structure drives the HTML preview and the final PDF —
// one source of truth so the preview matches the issued document.

import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { getBranding } from "@/lib/hms/pdf/branding";
import { renderLetterModel } from "@/lib/hms/letters/renderer";
import { safeParseData } from "@/lib/hms/letters/server";

export const GET = handler(
  async ({ req }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const letter = await db.letter.findUnique({
      where: { id },
      include: { attachments: { orderBy: { createdAt: "asc" }, select: { name: true } } },
    });
    if (!letter) throw Errors.notFound("Letter not found.");

    const branding = await getBranding();
    const website = await db.setting
      .findUnique({ where: { key: "public_url" }, select: { value: true } })
      .then((r) => r?.value ?? "")
      .catch(() => "");

    const model = renderLetterModel({
      letterId: letter.id,
      letterNumber: letter.letterNumber,
      letterType: letter.letterType,
      letterDate: letter.letterDate,
      status: letter.status,
      subject: letter.subject,
      body: letter.body,
      salutation: letter.salutation,
      closing: letter.closing,
      data: safeParseData(letter.dataJson),
      signatoryName: letter.signatoryName,
      signatoryPosition: letter.signatoryPosition,
      hasSignatureImage: Boolean(letter.signatorySignatureKey),
      enclosures: letter.attachments.map((a) => a.name),
      branding,
      website,
    });
    return ok(model);
  },
  { permission: PERMISSIONS.letters_view }
);
