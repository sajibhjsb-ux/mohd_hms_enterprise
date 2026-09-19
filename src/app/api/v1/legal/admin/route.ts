// MOHD.HMS ENTERPRISE — Legal document administration (Settings → Legal).
// GET    /api/v1/legal/admin  (settings.read)   — all versions + acceptance counts
// PUT    /api/v1/legal/admin  (settings.manage) — create/update a DRAFT version
// POST   /api/v1/legal/admin  (settings.manage) — publish a draft (archives the
//                                                   currently published version)
// DELETE /api/v1/legal/admin?id=… (settings.manage) — discard a draft
//
// Customers have NO write path here (permission-gated). Published versions are
// immutable — corrections ship as a new version. Section content is PLAIN TEXT
// and is rendered as text everywhere, so no HTML/sanitization surface exists.

import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import {
  deleteLegalDraft,
  ensureLegalDocuments,
  getLegalAdminOverview,
  publishLegalDraft,
  saveLegalDraft,
} from "@/lib/hms/legal/legal";
import { LEGAL_KINDS } from "@/lib/hms/legal/canonical";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    ""
  );
}

const sectionSchema = z.object({
  id: z.string().max(100).default(""),
  title: z.string().min(1, "Section title is required.").max(200),
  body: z.string().max(20000, "Section body is limited to 20000 characters."),
  needsReview: z.boolean().optional(),
});

const draftSchema = z.object({
  kind: z.enum(["TERMS", "PRIVACY"]),
  version: z
    .string()
    .regex(/^\d+\.\d+$/, "Version must look like 1.0 or 2.1.")
    .max(20),
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Effective date must be YYYY-MM-DD.")
    .nullable()
    .optional(),
  changeSummary: z.string().max(2000).default(""),
  sections: z
    .array(sectionSchema)
    .min(1, "A document needs at least one section.")
    .max(60, "A document is limited to 60 sections."),
});

export const GET = handler(
  async () => {
    await ensureLegalDocuments();
    return ok(await getLegalAdminOverview());
  },
  { permission: PERMISSIONS.settings_read }
);

export const PUT = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, draftSchema);
    const doc = await saveLegalDraft(
      {
        kind: body.kind,
        version: body.version,
        effectiveDate: body.effectiveDate ?? null,
        changeSummary: body.changeSummary,
        sections: body.sections,
      },
      user,
      clientIp(req)
    );
    return ok(doc);
  },
  { permission: PERMISSIONS.settings_manage }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, z.object({ id: z.string().min(1).max(64) }));
    const doc = await db.legalDocument.findUnique({ where: { id: body.id }, select: { id: true } });
    if (!doc) throw Errors.notFound("Draft document not found.");
    const published = await publishLegalDraft(doc.id, user, clientIp(req));
    return ok(published);
  },
  { permission: PERMISSIONS.settings_manage }
);

export const DELETE = handler(
  async ({ req, user }) => {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) throw Errors.badRequest("Provide the draft id as ?id=.");
    await deleteLegalDraft(id, user, clientIp(req));
    return ok({ discarded: true });
  },
  { permission: PERMISSIONS.settings_manage }
);
