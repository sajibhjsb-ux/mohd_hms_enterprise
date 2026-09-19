// MOHD.HMS ENTERPRISE — Letter AI generation endpoint (§9/§10/§13/§14/§45).
//
//   POST /api/v1/hr/letters/{id}/generate   { action, confirm? }
//
// Actions: generate | regenerate | shorten | expand | formal | concise | grammar
//
// CONTENT PROTECTION (§45): when the current body was HUMAN_EDITED, every
// destructive AI action requires {confirm: true} — the UI asks
// "This will replace the current content. Continue?" before sending.
// Only the draft content changes; status moves to AI_GENERATED (still a draft
// — human review before approval is mandatory, §15).

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { getBranding } from "@/lib/hms/pdf/branding";
import { assertRequiredFields, safeParseData, safeParseFields, templateSnapshot } from "@/lib/hms/letters/server";
import { generateLetterContent } from "@/lib/hms/letters/generation";
import { renderInitialBody, systemValues } from "@/lib/hms/letters/renderer";
import { LETTER_AI_ACTIONS, type LetterAiAction } from "@/lib/hms/letters/shared";
import { audit } from "@/lib/hms/services";

const generateSchema = z.object({
  action: z.enum(LETTER_AI_ACTIONS),
  confirm: z.boolean().optional(),
  instruction: z.string().max(2000).optional(),
});

const AI_PROTECTED_STATUSES = new Set(["DRAFT", "AI_GENERATED", "REJECTED"]);
const DESTRUCTIVE: LetterAiAction[] = ["generate", "regenerate", "shorten", "expand", "formal", "concise", "grammar"];

export const POST = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const body = await parseBody(req, generateSchema);

    const letter = await db.letter.findUnique({
      where: { id },
      include: { template: { select: { fieldsJson: true, aiInstructions: true, letterType: true, bodyTemplate: true, subjectHint: true, closingTemplate: true, pageSize: true, language: true, department: true, name: true } } },
    });
    if (!letter) throw Errors.notFound("Letter not found.");
    if (!AI_PROTECTED_STATUSES.has(letter.status)) {
      throw Errors.invalidTransition("AI actions are only available before approval.");
    }

    const fields = safeParseFields(letter.template?.fieldsJson ?? "");
    const data = safeParseData(letter.dataJson);

    // §12 — never let the AI paper over missing required information.
    assertRequiredFields(fields, data);

    // §45 — human edits are never silently replaced.
    if (letter.contentSource === "HUMAN_EDITED" && DESTRUCTIVE.includes(body.action) && body.confirm !== true) {
      throw Errors.conflict("This will replace the current content. Continue?");
    }

    const result = await generateLetterContent({
      action: body.action,
      snapshot: {
        letterType: letter.letterType,
        aiInstructions: letter.template?.aiInstructions ?? "",
        name: letter.letterNumber,
      },
      fields,
      data,
      currentSubject: letter.subject,
      // AI rewrite actions operate on the CURRENT SLOT content only — the
      // template wrapper is locked structure (§11/§14).
      currentBody: letter.bodySlot,
    });

    if (!result.ok) {
      throw Errors.internal(result.message);
    }

    // Place the AI content into the template's {{BODY}} slot — the wrapper
    // re-renders from the template snapshot, so the AI never touches the
    // template structure (§11/§46).
    const snapshot = templateSnapshot({
      name: letter.template?.name ?? "",
      letterType: letter.letterType,
      subjectHint: letter.template?.subjectHint ?? "",
      aiInstructions: letter.template?.aiInstructions ?? "",
      bodyTemplate: letter.template?.bodyTemplate ?? "{{BODY}}",
      closingTemplate: letter.template?.closingTemplate ?? "Yours faithfully,",
      fieldsJson: letter.template?.fieldsJson ?? "[]",
      pageSize: letter.template?.pageSize ?? "A4",
      language: letter.template?.language ?? "en",
    } as Parameters<typeof templateSnapshot>[0]);
    const branding = await getBranding();
    const values = systemValues({
      letterNumber: letter.letterNumber,
      letterDate: letter.letterDate,
      branding,
      salutation: "",
      signatoryName: letter.signatoryName,
      signatoryPosition: letter.signatoryPosition,
      body: result.body,
    });
    const renderedBody = renderInitialBody(snapshot, values, result.body);

    const updated = await db.letter.update({
      where: { id: letter.id },
      data: {
        subject: result.subject || letter.subject,
        bodySlot: result.body,
        body: renderedBody,
        contentSource: "AI",
        status: letter.status === "DRAFT" || letter.status === "REJECTED" ? "AI_GENERATED" : letter.status,
        updatedById: user.id,
        events: {
          create: {
            action: body.action === "generate" ? "AI_GENERATED" : body.action === "regenerate" ? "AI_REGENERATED" : "AI_ACTION",
            detail: `AI action: ${body.action}${body.instruction ? ` — "${body.instruction.slice(0, 120)}"` : ""}`,
            actorId: user.id,
            actorName: user.name,
          },
        },
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: body.action === "generate" ? "LETTER_AI_GENERATED" : body.action === "regenerate" ? "LETTER_AI_REGENERATED" : "LETTER_AI_ACTION",
      resourceType: "LETTER",
      resourceId: letter.id,
      metadata: { letterNumber: letter.letterNumber, action: body.action },
      ip: req.headers.get("x-forwarded-for") ?? "",
    });

    return ok({ id: updated.id, subject: updated.subject, bodySlot: updated.bodySlot, body: updated.body, status: updated.status, contentSource: updated.contentSource });
  },
  { permission: PERMISSIONS.letters_ai }
);
