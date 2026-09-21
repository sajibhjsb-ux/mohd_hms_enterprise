// MOHD.HMS ENTERPRISE — AI checklist generation (AI checklist spec §3/§15/§71).
// POST /api/v1/checklists/generate { sourceType, sourceId, templateId? }
// Real AI provider call through the server-side SDK — never a fake hardcoded
// generator. Falls back to an approved template when AI is unavailable (§72).
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, CHECKLIST_SOURCE_TYPES } from "@/lib/hms/constants";
import { generateChecklistDraft } from "@/lib/hms/checklist/engine";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const bodySchema = z.object({
  sourceType: z.enum(CHECKLIST_SOURCE_TYPES),
  sourceId: z.string().min(1, "sourceId is required."),
  templateId: z.string().min(1).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, bodySchema);
    const result = await generateChecklistDraft({
      actorId: user.id,
      actorEmail: user.email,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      mode: "AI_ASSIST",
      templateId: body.templateId,
    });
    await emit({
      type: EVENT_TYPES.CHECKLIST_GENERATED,
      resourceType: "CHECKLIST_INSTANCE",
      resourceId: result.instanceId,
      payload: { code: result.code, status: result.status, origin: result.origin },
      actorType: "USER",
      actorId: user.id,
    });
    return ok(result, 201);
  },
  { permission: PERMISSIONS.checklist_generate }
);
