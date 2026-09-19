// MOHD.HMS ENTERPRISE — Single letter API (§13/§28/§44).
//
//   GET    /api/v1/hr/letters/{id} — full detail (data, content, timeline)
//   PATCH  /api/v1/hr/letters/{id} — edit data/content while editable;
//          finalized letters are immutable (§28 — create a revision instead)
//   DELETE /api/v1/hr/letters/{id} — hard-delete allowed only for drafts that
//          were never finalized; anything else must be archived (§28)

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { getBranding } from "@/lib/hms/pdf/branding";
import { letterDetailDto, safeParseFields, templateSnapshot } from "@/lib/hms/letters/server";
import { renderInitialBody, systemValues } from "@/lib/hms/letters/renderer";
import { audit } from "@/lib/hms/services";

const EDITABLE_STATUSES = new Set(["DRAFT", "AI_GENERATED", "REJECTED"]);

const patchSchema = z.object({
  data: z.record(z.string(), z.string().max(8000)).optional(),
  subject: z.string().max(400).optional(),
  // bodySlot = the AI/human-authored {{BODY}} slot content; the template
  // wrapper around it re-renders automatically (never editable here, §11).
  bodySlot: z.string().max(20000).optional(),
  salutation: z.string().max(200).optional(),
  closing: z.string().max(400).optional(),
  letterDate: z.string().datetime().optional(),
  signatoryName: z.string().max(120).optional(),
  signatoryPosition: z.string().max(120).optional(),
  /** Client signals a restore-to-template request (§13): clears the slot. */
  restoreTemplate: z.boolean().optional(),
});

async function loadEditable(id: string) {
  const letter = await db.letter.findUnique({ where: { id }, include: { template: { select: { fieldsJson: true } } } });
  if (!letter) throw Errors.notFound("Letter not found.");
  if (!EDITABLE_STATUSES.has(letter.status)) {
    throw Errors.invalidTransition(
      letter.status === "UNDER_REVIEW"
        ? "This letter is under review — recall it (reject) before editing."
        : "This letter is finalized and immutable. Create a new letter if changes are needed."
    );
  }
  return letter;
}

export const GET = handler(
  async ({ req }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const letter = await db.letter.findUnique({
      where: { id },
      include: {
        template: { select: { code: true, name: true, fieldsJson: true } },
        employee: { select: { firstName: true, lastName: true } },
        attachments: { orderBy: { createdAt: "asc" } },
        events: { orderBy: { createdAt: "desc" }, take: 50 },
      },
    });
    if (!letter) throw Errors.notFound("Letter not found.");
    return ok(letterDetailDto(letter));
  },
  { permission: PERMISSIONS.letters_view }
);

export const PATCH = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const body = await parseBody(req, patchSchema);
    const letter = await loadEditable(id);

    // Data changes: merge (existing values preserved unless overridden) and
    // ALWAYS re-render the deterministic template wrapper around the slot —
    // the wrapper is template-owned structure (§11/§46).
    const mergedData = { ...safeDataJson(letter.dataJson), ...(body.data ?? {}) };

    // SIGNATORY_* template fields (if present) sync into the letter columns —
    // explicit payload values still win when the template has no such fields.
    const tmpl = await loadTemplate(letter.templateId);
    const tmplFields = safeParseFields(tmpl.fieldsJson);
    const hasSignNameField = tmplFields.some((f) => f.key === "SIGNATORY_NAME");
    const hasSignPosField = tmplFields.some((f) => f.key === "SIGNATORY_POSITION");
    const nextSignName =
      body.signatoryName !== undefined ? body.signatoryName
      : hasSignNameField && String(mergedData["SIGNATORY_NAME"] ?? "").trim() ? String(mergedData["SIGNATORY_NAME"]).trim()
      : letter.signatoryName;
    const nextSignPos =
      body.signatoryPosition !== undefined ? body.signatoryPosition
      : hasSignPosField && String(mergedData["SIGNATORY_POSITION"] ?? "").trim() ? String(mergedData["SIGNATORY_POSITION"]).trim()
      : letter.signatoryPosition;

    const nextSlot = body.restoreTemplate ? "" : (body.bodySlot !== undefined ? body.bodySlot : letter.bodySlot);
    const slotChanged = nextSlot !== letter.bodySlot;
    const nextContentSource = body.restoreTemplate ? "TEMPLATE" : slotChanged ? "HUMAN_EDITED" : letter.contentSource;

    // Re-render the wrapper when data/signatory/slot changed or on restore.
    let nextBody = letter.body;
    if (body.data !== undefined || slotChanged || body.restoreTemplate || body.signatoryName !== undefined || body.signatoryPosition !== undefined) {
      const branding = await getBranding();
      const values = systemValues({
        letterNumber: letter.letterNumber,
        letterDate: letter.letterDate,
        branding,
        salutation: "",
        signatoryName: nextSignName,
        signatoryPosition: nextSignPos,
        body: nextSlot,
      });
      const snapshot = templateSnapshot(tmpl);
      nextBody = renderInitialBody(snapshot, values, nextSlot);
    }

    const updated = await db.letter.update({
      where: { id: letter.id },
      data: {
        ...(body.data !== undefined ? { dataJson: JSON.stringify(mergedData) } : {}),
        ...(body.subject !== undefined ? { subject: body.subject } : {}),
        bodySlot: nextSlot,
        body: nextBody,
        ...(body.salutation !== undefined ? { salutation: body.salutation } : {}),
        ...(body.closing !== undefined ? { closing: body.closing } : {}),
        ...(body.letterDate !== undefined ? { letterDate: new Date(body.letterDate) } : {}),
        signatoryName: nextSignName,
        signatoryPosition: nextSignPos,
        contentSource: nextContentSource,
        recipientName: String(mergedData["RECIPIENT_NAME"] ?? mergedData["EMPLOYEE_NAME"] ?? letter.recipientName).trim(),
        recipientCompany: String(mergedData["RECIPIENT_COMPANY"] ?? letter.recipientCompany).trim(),
        updatedById: user.id,
        events: {
          create: {
            action: "EDITED",
            detail: `Updated: ${[...(body.data !== undefined ? ["details"] : []), ...(body.subject !== undefined ? ["subject"] : []), ...(slotChanged ? ["content"] : []), ...(body.restoreTemplate ? ["restored template text"] : []), ...(body.signatoryName !== undefined || body.signatoryPosition !== undefined ? ["signatory"] : []), ...(body.letterDate !== undefined ? ["letter date"] : [])].join(", ") || "revision"}`,
            actorId: user.id,
            actorName: user.name,
          },
        },
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "LETTER_EDITED",
      resourceType: "LETTER",
      resourceId: letter.id,
      metadata: { letterNumber: letter.letterNumber },
      ip: req.headers.get("x-forwarded-for") ?? "",
    });

    return ok({ id: updated.id, saved: true });
  },
  { permission: PERMISSIONS.letters_edit }
);

export const DELETE = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const letter = await db.letter.findUnique({ where: { id } });
    if (!letter) throw Errors.notFound("Letter not found.");
    if (!EDITABLE_STATUSES.has(letter.status)) {
      throw Errors.invalidTransition("Only unfinished drafts can be deleted. Finalized letters are archived instead.");
    }
    await db.letter.delete({ where: { id } });
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "LETTER_DELETED",
      resourceType: "LETTER",
      resourceId: letter.id,
      metadata: { letterNumber: letter.letterNumber, status: letter.status },
      ip: req.headers.get("x-forwarded-for") ?? "",
    });
    return ok({ deleted: true });
  },
  { permission: PERMISSIONS.letters_delete }
);

// ── helpers ──

function safeDataJson(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function loadTemplate(templateId: string | null) {
  if (!templateId) throw Errors.badRequest("This letter has no template.");
  const t = await db.letterTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw Errors.badRequest("The template for this letter no longer exists.");
  return t;
}
