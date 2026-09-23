// POST /api/v1/ai/generate-structured — centralized structured AI generation
// (central AI config spec §11/§25).
//
// The prompt is built SERVER-SIDE from the validated context (the client
// cannot inject arbitrary prompt content), the provider is asked for a JSON
// object, and the output is validated against the feature's backend Zod
// schema BEFORE it is returned — malformed AI output can never reach
// business records (spec §25). AI output is a DRAFT: important results still
// pass human review before being saved (spec §26).

import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { getAiFeature } from "@/lib/hms/ai/features";
import { aiGenerateStructured } from "@/lib/hms/ai/service";
import { aiFailureToApiError } from "@/lib/hms/ai/http";

const bodySchema = z.object({
  feature: z.string().trim().min(1).max(64),
  context: z.record(z.string().max(64), z.string().max(2000)).optional(),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, bodySchema);

  const feature = getAiFeature(body.feature);
  if (!feature) throw Errors.notFound("Unknown AI feature.");
  if (feature.kind !== "structured" || !feature.buildPrompt || !feature.schema) {
    throw Errors.badRequest("This feature does not support structured generation.");
  }
  if (!roleCan(user.role, feature.permission)) throw Errors.forbidden();

  const res = await aiGenerateStructured({
    feature: feature.id,
    system: feature.system,
    prompt: feature.buildPrompt(body.context ?? {}),
    schema: feature.schema,
    userId: user.id,
  });

  if (!res.ok) throw aiFailureToApiError(res);

  return ok({
    data: res.data,
    feature: feature.id,
    provider: res.provider,
    model: res.model,
    requestId: res.requestId,
    usage: res.usage,
    durationMs: res.durationMs,
  });
});
