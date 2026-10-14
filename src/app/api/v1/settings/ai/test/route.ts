// POST /api/v1/settings/ai/test — Test Connection / Auto Select Model
// (central AI config spec §6). Makes REAL, validated provider requests using
// the credential currently entered in the form (when present), walking the
// provider's eligible models until one succeeds. Only the backend authors an
// authoritative CONNECTED state; nothing here ever fakes success.

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import { PERMISSIONS } from "@/lib/hms/constants";
import { aiTestConnection } from "@/lib/hms/ai/service";

export const runtime = "nodejs";

const bodySchema = z.object({
  provider: z.enum(["GOOGLE_GEMINI", "ANTHROPIC_CLAUDE", "OPENAI", "NVIDIA", "ZAI_PLATFORM"]),
  apiKey: z.string().trim().min(1).max(1024).optional(),
  model: z.string().trim().max(120).optional(),
  testAll: z.boolean().optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, bodySchema);
    const result = await aiTestConnection({
      provider: body.provider,
      userId: user.id,
      userEmail: user.email,
      apiKey: body.apiKey,
      preferredModel: body.model,
      testAll: body.testAll,
    });

    // Audit the test OUTCOME only — never the credential (spec §8/§16).
    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "AI_CONFIG_TESTED",
      resourceType: "AiProviderProfile",
      resourceId: body.provider,
      metadata: {
        runId: result.runId,
        provider: result.provider,
        ok: result.ok,
        status: result.status,
        model: result.testedModel || result.model,
        attempts: result.attempts.map((a) => ({ model: a.model, ok: a.ok, code: a.errorCode })),
        durationMs: result.durationMs,
      },
    });

    return ok(result);
  },
  { permission: PERMISSIONS.settings_manage }
);
