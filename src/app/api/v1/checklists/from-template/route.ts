// MOHD.HMS ENTERPRISE — Attach an approved checklist template to a source (§22 USE TEMPLATE).
// POST /api/v1/checklists/from-template { sourceType, sourceId, templateId }
// Deterministic path — no AI involved. The template version is snapshotted.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS, CHECKLIST_SOURCE_TYPES } from "@/lib/hms/constants";
import { generateChecklistDraft } from "@/lib/hms/checklist/engine";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const bodySchema = z.object({
  sourceType: z.enum(CHECKLIST_SOURCE_TYPES),
  sourceId: z.string().min(1, "sourceId is required."),
  templateId: z.string().min(1, "templateId is required."),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, bodySchema);
    const result = await generateChecklistDraft({
      actorId: user.id,
      actorEmail: user.email,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      mode: "TEMPLATE",
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
