// POST /api/v1/settings/ai/models — provider model discovery (spec §5).
// Uses the credential currently entered in the form when present, otherwise the
// stored ACTIVE credential. Falls back to the maintained server-side catalog
// when the provider has no discovery API or the call fails — and says which.
// The credential is sent in the request BODY (never a URL), never returned.

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { discoverModels, getProfile, getGlobalConfig } from "@/lib/hms/ai/service";
import { decryptAiSecret } from "@/lib/hms/ai/crypto";

export const runtime = "nodejs";

const bodySchema = z.object({
  provider: z.enum(["GOOGLE_GEMINI", "ANTHROPIC_CLAUDE", "OPENAI", "NVIDIA", "ZAI_PLATFORM"]),
  apiKey: z.string().trim().max(1024).optional(),
});

export const POST = handler(
  async ({ req }) => {
    const body = await parseBody(req, bodySchema);
    const cfg = await getGlobalConfig();
    let key = body.apiKey?.trim() ?? "";
    if (!key) {
      const profile = await getProfile(body.provider);
      if (profile?.apiKeyEnc) key = decryptAiSecret(profile.apiKeyEnc) ?? "";
    }
    const res = await discoverModels(body.provider, key, Math.min(cfg.timeoutMs, 20_000));
    return ok(res);
  },
  { permission: PERMISSIONS.settings_manage }
);
