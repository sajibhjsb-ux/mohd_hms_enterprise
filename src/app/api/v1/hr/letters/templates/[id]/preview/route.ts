// MOHD.HMS ENTERPRISE — Template live preview (§3 "Preview final result").
//
//   POST /api/v1/hr/letters/templates/{id}/preview
//
// Renders the template against sample/entered data WITHOUT creating a letter —
// used by the template editor and the create-letter wizard.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { getBranding } from "@/lib/hms/pdf/branding";
import { defaultSalutation, renderInitialBody, renderLetterModel, resolvePlaceholders, systemValues } from "@/lib/hms/letters/renderer";
import { safeParseFields } from "@/lib/hms/letters/server";

const previewSchema = z.object({
  data: z.record(z.string(), z.string().max(8000)).default({}),
  body: z.string().max(20000).default(""),
  signatoryName: z.string().max(120).default(""),
  signatoryPosition: z.string().max(120).default(""),
});

export const POST = handler(
  async ({ req }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
    const t = await db.letterTemplate.findUnique({ where: { id } });
    if (!t) throw Errors.notFound("Letter template not found.");

    const body = await parseBody(req, previewSchema);
    const branding = await getBranding();
    const website = await db.setting
      .findUnique({ where: { key: "public_url" }, select: { value: true } })
      .then((r) => r?.value ?? "")
      .catch(() => "");

    const fields = safeParseFields(t.fieldsJson);
    const data = { ...body.data };
    // Fill unfilled fields with visible sample markers so the editor preview
    // communicates which content comes from where — but never invent facts in
    // real letters (markers are preview-only, never persisted).
    for (const f of fields) {
      if (!String(data[f.key] ?? "").trim()) data[f.key] = `[${f.label}]`;
    }

    const letterNumber = t.code; // preview reference
    const letterDate = new Date();
    const salutation = body.signatoryName ? defaultSalutation(data) : defaultSalutation(data);
    const values = systemValues({
      letterNumber,
      letterDate,
      branding,
      website,
      salutation: "",
      signatoryName: body.signatoryName || "[Signatory Name]",
      signatoryPosition: body.signatoryPosition || "[Signatory Position]",
      body: body.body,
    });
    const initialBody = body.body.trim() || renderInitialBody({ ...t, fields }, values, "");

    const model = renderLetterModel({
      letterId: "preview",
      letterNumber,
      letterType: t.letterType,
      letterDate,
      status: "PREVIEW",
      subject: resolvePlaceholders(t.subjectHint, values).trim() || "[Subject]",
      body: initialBody,
      salutation,
      closing: t.closingTemplate || "Yours faithfully,",
      data,
      signatoryName: body.signatoryName || "[Signatory Name]",
      signatoryPosition: body.signatoryPosition || "[Signatory Position]",
      hasSignatureImage: false,
      enclosures: [],
      branding,
      website,
    });

    return ok(model);
  },
  { permission: PERMISSIONS.letters_view }
);
