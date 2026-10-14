# MOHD.HMS ENTERPRISE
# CENTRAL AI CONFIGURATION — ROOT CAUSE & IMPLEMENTATION REPORT

Settings → **AI Configuration** no longer reports a false failure, and the AI
platform is now a real multi-provider service (Gemini, Claude, OpenAI, NVIDIA,
built-in platform) with honest connection status, real connection testing,
model discovery and per-provider credential isolation.

## 1. Symptom (as reported)

The Settings → AI Configuration tab showed:

- **Connection Status: Not Configured**
- **Connection Test: Failed**
- **"Something went wrong. Please try again."**

…even after saving a valid-looking API key, while AI was shown as *Enabled*.

## 2. Root cause (reproducible, evidence-backed)

Three independent defects produced the misleading UI:

1. **The test endpoint never existed.**
   `POST /api/v1/settings/ai/test` was implemented in the UI
   (`ai-tab.tsx`) but had **no route file** — it was absent from commit
   `b718235` and from the build (`.next/server/app/api/v1/settings/ai/`
   contained only `route.js`). The unmatched API path fell into the SPA
   catch-all (`[[...slug]]`), which returned **HTTP 200 with HTML**. The client
   wrapper (`api-client.ts`) then failed `res.json()` and surfaced its generic
   fallback:
   `{ code: "UNKNOWN", message: "Something went wrong. Please try again." }`.
   Reproduced live: `curl -X POST .../api/v1/settings/ai/test` → `200`, HTML
   body.

2. **The saved key was never promoted and status never transitioned.**
   A singleton `AiConfiguration` row held `provider = GOOGLE_GEMINI`,
   `apiKeyEnc` **empty**, `pendingApiKeyEnc` populated (last-4 `rE2w`),
   `model = ""`, `status = "NOT_CONFIGURED"`, `lastTestedAt = null`. The key was
   stored as *pending* but, with no test route, was never activated — so the
   UI was correctly told "Not Configured" forever.

3. **The client trusted no honest source of truth.**
   The tab compared a stored status literal (`=== "CONFIGURED"` / `"ACTIVE"`)
   and inferred "Connected" from the presence of a key rather than a validated
   provider response — the one behaviour the spec forbids (§7).

## 3. What was implemented

### 3.1 Provider + model registry — `src/lib/hms/ai/providers.ts`

The single source of truth for providers: `GOOGLE_GEMINI`, `ANTHROPIC_CLAUDE`,
`OPENAI`, `NVIDIA`, `ZAI_PLATFORM`. Each declares auth model
(`requiresKey`), documented endpoint, docs URL, discovery support, capabilities
and a maintained server-side **model catalog**. `modelCandidates()` defines the
deterministic auto-select/auto-test order (chosen model → recommended →
remaining, never deprecated).

### 3.2 Central AIService — `src/lib/hms/ai/service.ts`

The one backend AI surface every feature calls:

- Per-provider **profiles** with isolated credentials/models, auto-seeded and
  legacy-singleton migration.
- Adapters for Gemini, Anthropic Messages, OpenAI-compatible (OpenAI + NVIDIA)
  and the built-in platform, with bounded retries/backoff and per-call timeouts.
- `aiGenerate` / `aiGenerateStructured` / `extractJsonObject` — API-compatible
  with existing callers (`checklist/ai.ts`, `letters/generation.ts`,
  `ai.ts`, the two `ai/*` routes).
- Optional cross-provider **fallback chain** (duplicate-/circular-safe).
- Rate limiting, safe usage logging (metadata only) and **honest error
  classification** (`AI_DISABLED`, `AI_NOT_CONFIGURED`, `AI_AUTH_FAILED`,
  `AI_QUOTA_EXCEEDED`, `AI_MODEL_UNAVAILABLE`, `AI_RATE_LIMITED`,
  `AI_TIMEOUT`, `AI_SERVICE_UNAVAILABLE`, `AI_BAD_RESPONSE`,
  `AI_PROVIDER_ERROR`).
- `aiTestConnection()` — walks the provider's candidate models with a real
  request, stops early on success, records per-model attempts
  (`AiModelTestRun`) and persists the **honest** resulting status. A pending
  (rotated) credential is promoted **only** after it verifiably works.

### 3.3 API routes

| Method + path | Purpose |
|---|---|
| `GET /api/v1/settings/ai` | global config + all provider profiles, **masked credentials only** |
| `PUT /api/v1/settings/ai` | global settings and/or one profile (credential stored *pending*, model/enable) |
| `POST /api/v1/settings/ai/test` | **the previously missing route** — real Test Connection |
| `POST /api/v1/settings/ai/models` | live model discovery (body, never URL; catalog fallback) |

All are guarded by the existing `settings.manage` RBAC permission.

### 3.4 Settings UI — `src/components/hms/modules/settings/ai-tab.tsx`

Provider tabs with per-provider status, model dropdown, credential entry
(transient, masked readback), **Test Connection**, live-model loading, default
provider + fallback selection and the honest status state machine. Save stores
a new key as pending; only a successful test shows **Connected**.

## 4. Honest connection state machine

`NOT_CONFIGURED | SAVED_NOT_TESTED | TESTING | CONNECTED | FAILED | AUTH_FAILED |
MODEL_UNAVAILABLE | RATE_LIMITED | QUOTA_ISSUE | SERVICE_UNAVAILABLE`

**Only `aiTestConnection` can author `CONNECTED`.** Saving a key, selecting a
model, toggling enable, or a model merely appearing in the catalog are never
treated as proof of connectivity. Changing a credential or model moves the
profile back to `SAVED_NOT_TESTED`.

## 5. Security

- Credentials encrypted **AES-256-GCM** (`ai/crypto.ts`), same mechanism as
  SMTP/WhatsApp secrets; key chain
  `AI_SETTINGS_ENCRYPTION_KEY → EMAIL_CRYPTO_SECRET → OTP_HASH_SECRET →
  NEXTAUTH_SECRET`.
- Raw keys **never** returned to the browser, logged, audited or written to
  usage logs — only a `••••••••1234` hint is stored/displayed.
- Rotation: a new key is *pending* until it passes Test Connection; the previous
  working key stays active until then.
- Discovery/test credentials travel in the request **body**, never the URL.
- Audit events `AI_CONFIG_UPDATED` / `AI_CONFIG_TESTED` carry masked metadata
  only.

## 6. WhatsApp inbound integration

`src/lib/hms/whatsapp/inbound.ts` now consults the central AIService — but only
as a **fallback classifier**: deterministic rules remain the source of truth,
and AI is called *only when the rules return `UNKNOWN`*, only to choose one of
the known intents, with an 8-second cap. On any failure/timeout the rule result
is kept. Complaint/status/invoice/handoff paths, throttling, human-handoff gates
and loop prevention are unchanged. If AI is disabled or unreachable, behaviour
is identical to before.

## 7. Verification

- `bun scripts/ai-providers-selfcheck.ts` — registry/candidate-ordering
  self-check (**passes**).
- `bun scripts/ai-config-qa.ts` — end-to-end QA (requires dev server +
  seeded accounts): config save/encrypt/mask, real Test Connection success &
  invalid-key failure, disabled/not-configured states, RBAC (401/403),
  generation, usage logs, rate limiting, audit. Rewritten for the new contract.
- `tsc --noEmit` and `eslint` are clean on every file touched by this change.

## 8. Known limitations / not verified here

- **Real external provider connectivity was not confirmed** — no valid Gemini/
  Claude/OpenAI/NVIDIA keys are available in this environment. Test Connection
  honestly reports failure/unknown rather than faking success.
- The **built-in Z.ai platform** calls recorded in `AiUsageLog` are currently
  failing (`ZAI_PLATFORM` / `z-ai-chat`, `AI_PROVIDER_ERROR`) — an environment/
  provider issue outside this change; the UI now reports it honestly.
- `prisma/schema.prisma` keeps `provider = "sqlite"`; the deploy pipeline
  (`deployment/deploy.sh`) flips it to `postgresql` at build. New models
  `AiProviderProfile`, `AiModelTestRun` and `AiConfiguration.fallbackChain`
  have been pushed to the local PostgreSQL database.
