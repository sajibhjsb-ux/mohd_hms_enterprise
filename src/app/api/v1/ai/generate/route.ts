// POST /api/v1/ai/generate — the ONE centralized AI generation endpoint for
// frontend features (central AI config spec §11/§12/§13).
//
//   Browser → this route (auth + RBAC + feature registry) → AIService → provider
//
// The frontend NEVER talks to the AI provider directly and never sees any
// credential. Every request identifies its feature (spec §13); the feature
// registry binds it to an RBAC permission and prompt rules. AIService handles
// gating (enabled / configured / rate limits), provider calls, timeouts,
// retries, usage logging and honest error normalization.

import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { roleCan } from "@/lib/hms/rbac";
import { aiContextBlock, getAiFeature } from "@/lib/hms/ai/features";
import { aiGenerate } from "@/lib/hms/ai/service";
import { aiFailureToApiError } from "@/lib/hms/ai/http";

const bodySchema = z.object({
  feature: z.string().trim().min(1).max(64),
  prompt: z.string().max(8000).optional(),
  context: z.record(z.string().max(64), z.string().max(2000)).optional(),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, bodySchema);

  const feature = getAiFeature(body.feature);
  if (!feature) throw Errors.notFound("Unknown AI feature.");
  if (feature.kind !== "text") throw Errors.badRequest("This feature requires the structured generation endpoint.");
  if (!roleCan(user.role, feature.permission)) throw Errors.forbidden();

  const prompt = (body.prompt ?? "").trim();
  if (!prompt) throw Errors.badRequest("A prompt is required.");
  if (prompt.length > feature.maxPromptChars) {
    throw Errors.badRequest(`The request text is too long (max ${feature.maxPromptChars} characters for ${feature.label}).`);
  }

  const res = await aiGenerate({
    feature: feature.id,
    system: feature.system,
    prompt: `${prompt}${aiContextBlock(body.context)}`,
    userId: user.id,
  });

  if (!res.ok) throw aiFailureToApiError(res);

  return ok({
    text: res.text,
    feature: feature.id,
    provider: res.provider,
    model: res.model,
    requestId: res.requestId,
    usage: res.usage,
    durationMs: res.durationMs,
    // NEVER: api_key / encrypted_api_key / credential / secret (spec §12).
  });
});
