/**
 * Regression tests for AI model selection + honest connection classification
 * (NVIDIA NIM stale-catalog failure). Pure/offline: no DB, no network — the
 * provider probe is injected, so invalid-key / deprecated / unavailable /
 * timeout / stale-result paths are exercised deterministically.
 *
 * Run: bun scripts/ai-nvidia-regression.ts
 */
/// <reference types="bun-types" />
import assert from "node:assert/strict";
import { plugin } from "bun";

// service.ts imports "server-only", which Next injects at build time but is not
// resolvable from a plain Bun script. Stub it for this offline test only.
plugin({
  name: "stub-server-only",
  setup(build) {
    build.module("server-only", () => ({ exports: {}, loader: "object" }));
  },
});

import { getProviderDef } from "../src/lib/hms/ai/providers";
const svc = await import("../src/lib/hms/ai/service");
const { classifyError, walkCandidates, selectCandidates, modelFor, savedStatus, AiHttpError } = svc;
type GenerateOutput = { text: string; usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }; model: string };

const nv = getProviderDef("NVIDIA")!;
let passed = 0;
function ok(name: string, cond: boolean) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
}
function section(t: string) {
  console.log(`\n■ ${t}`);
}

console.log("═══ AI MODEL SELECTION — REGRESSION ═══");

section("Invalid credential");
ok("401 invalid key → AI_AUTH_FAILED", classifyError(401, '{"error":{"message":"Invalid API key"}}').code === "AI_AUTH_FAILED");
ok("403 forbidden → AI_AUTH_FAILED", classifyError(403, "Forbidden").code === "AI_AUTH_FAILED");

section("Deprecated / retired model (HTTP 410 / end-of-life notice)");
{
  const body = '{"type":"about:blank","title":"Gone","status":410,"detail":"The model \'qwen/qwen2.5-coder-32b-instruct\' has reached its end of life on 2026-05-12T00:00:00Z and is no longer available."}';
  ok("NVIDIA 410 problem+json → AI_MODEL_DEPRECATED", classifyError(410, body).code === "AI_MODEL_DEPRECATED");
  ok("Gemini 'no longer available to new users' → AI_MODEL_DEPRECATED", classifyError(404, "This model models/gemini-2.5-flash is no longer available to new users.").code === "AI_MODEL_DEPRECATED");
  ok("retired model is never a candidate", !selectCandidates(nv, "qwen/qwen2.5-coder-32b-instruct").includes("qwen/qwen2.5-coder-32b-instruct"));
  ok("no deprecated catalog model is ever a candidate", !selectCandidates(nv, "").some((id) => nv.catalog.some((m) => m.id === id && m.deprecated)));
}

section("Unavailable model (per-account entitlement)");
ok("404 'Not found for account' → AI_MODEL_UNAVAILABLE", classifyError(404, "Function '9b96341b': Not found for account 'XaLg'").code === "AI_MODEL_UNAVAILABLE");

section("Candidate selection + bounds");
{
  const cands = selectCandidates(nv, "");
  ok("recommended current model leads the list", cands[0] === "nvidia/nemotron-3.5-lightning-30b-a3b");
  ok("candidate list is bounded (<= 8)", cands.length <= 8);
  ok("an explicitly chosen (non-retired) model is tried first", selectCandidates(nv, "meta/llama-3.2-11b-vision-instruct")[0] === "meta/llama-3.2-11b-vision-instruct");
  ok("blank preference falls back to a recommended model", selectCandidates(nv, "")[0] === "nvidia/nemotron-3.5-lightning-30b-a3b");
  const withDiscovered = selectCandidates(nv, "", [{ id: "meta/llama-3.2-11b-vision-instruct", label: "", source: "discovered", capabilities: [] }]);
  ok("live-discovered chat model is included exactly once", withDiscovered.filter((m) => m === "meta/llama-3.2-11b-vision-instruct").length === 1);
  ok("discovered utility model (embed) is filtered out", !selectCandidates(nv, "", [{ id: "nvidia/embed-qa-4", label: "", source: "discovered", capabilities: [] }]).includes("nvidia/embed-qa-4"));
}

section("Successful alternative model (first retired, second works)");
{
  const calls: string[] = [];
  const walk = await walkCandidates(
    ["meta/llama-3.3-70b-instruct", "nvidia/nemotron-3.5-lightning-30b-a3b"],
    async (m): Promise<GenerateOutput> => {
      calls.push(m);
      if (m.includes("llama-3.3")) throw new AiHttpError(410, "AI_MODEL_DEPRECATED", "retired");
      return { text: "OK", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: m };
    }
  );
  ok("falls through to the working model", calls.length === 2 && walk.success?.model === "nvidia/nemotron-3.5-lightning-30b-a3b");
  ok("stops at first verified success", walk.stoppedEarly === true);
  ok("retired attempt records 410 + AI_MODEL_DEPRECATED", walk.attempts[0].errorCode === "AI_MODEL_DEPRECATED" && walk.attempts[0].httpStatus === 410);
  ok("successful attempt carries 200 + preview", walk.attempts[1].ok && walk.attempts[1].httpStatus === 200 && walk.attempts[1].outputPreview === "OK");
}

section("All candidates failing (honest; no 'every model tested' claim)");
{
  const walk = await walkCandidates(["a", "b", "c"], async (m): Promise<GenerateOutput> => { throw new AiHttpError(404, "AI_MODEL_UNAVAILABLE", `not found: ${m}`); });
  ok("every eligible candidate was attempted", walk.attempts.length === 3);
  ok("no success reported", walk.success === null && walk.attempts.every((a) => !a.ok));
  ok("not marked as stopped early when all fail", walk.stoppedEarly === false);
}

section("Timeout");
{
  const walk = await walkCandidates(["x"], async (): Promise<GenerateOutput> => { throw new AiHttpError(504, "AI_TIMEOUT", "timed out"); });
  ok("timeout recorded with 504 + AI_TIMEOUT", walk.attempts[0].httpStatus === 504 && walk.attempts[0].errorCode === "AI_TIMEOUT");
}

section("Credential-wide failure stops the walk (no quota hammering)");
{
  const calls: string[] = [];
  await walkCandidates(["a", "b", "c"], async (m): Promise<GenerateOutput> => { calls.push(m); throw new AiHttpError(401, "AI_AUTH_FAILED", "bad key"); });
  ok("auth failure stops after one attempt", calls.length === 1);
}

section("Stale test result after a model is retired");
{
  ok("retired configured model is not used for generation", modelFor(nv, { model: "qwen/qwen2.5-coder-32b-instruct", testedModel: "nvidia/nemotron-3.5-lightning-30b-a3b" }) === "nvidia/nemotron-3.5-lightning-30b-a3b");
  ok("empty model falls back to the current default", modelFor(nv, { model: "", testedModel: "" }) === nv.defaultModel);
  ok("pending credential is never CONNECTED", savedStatus({ apiKeyEnc: "x", pendingApiKeyEnc: "p", status: "CONNECTED" }, true) === "SAVED_NOT_TESTED");
  ok("no credential → NOT_CONFIGURED", savedStatus({ apiKeyEnc: "", pendingApiKeyEnc: "", status: "FAILED" }, true) === "NOT_CONFIGURED");
}

console.log(`\n═══ ai-nvidia regression: OK (${passed} checks) ═══`);
