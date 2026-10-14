/**
 * Self-check for the pure AI provider/model registry (no server, no DB).
 * Run: bun scripts/ai-providers-selfcheck.ts
 */
import assert from "node:assert/strict";
import { AI_PROVIDERS, getProviderDef, getCatalogModel, modelCandidates, externalProviders } from "../src/lib/hms/ai/providers";

const ids = AI_PROVIDERS.map((p) => p.id);
assert.equal(new Set(ids).size, ids.length, "provider ids must be unique");

for (const p of AI_PROVIDERS) {
  assert.ok(p.catalog.length >= 1, `${p.id} needs a catalog`);
  assert.ok(p.catalog.every((m) => m.provider === p.id), `${p.id} catalog entries must carry the provider id`);
  if (p.requiresKey) assert.ok(p.defaultModel, `${p.id} (keyed) needs a default model`);
}
assert.deepEqual(
  externalProviders().map((p) => p.id).sort(),
  ["ANTHROPIC_CLAUDE", "GOOGLE_GEMINI", "NVIDIA", "OPENAI"],
  "exactly the four external (keyed) providers"
);

const gemini = getProviderDef("GOOGLE_GEMINI")!;
assert.equal(getCatalogModel("GOOGLE_GEMINI", "gemini-2.5-pro")?.id, "gemini-2.5-pro");
assert.equal(getCatalogModel("GOOGLE_GEMINI", "nope"), null);

// Candidate ordering: preferred first, recommended next, no deprecated, no dupes.
const cands = modelCandidates(gemini, "gemini-3.8-flash");
assert.equal(cands[0].id, "gemini-3.8-flash", "admin-chosen model is tried first");
assert.ok(!cands.some((m) => m.deprecated), "deprecated models are never auto-tried");
assert.equal(new Set(cands.map((m) => m.id)).size, cands.length, "no duplicate candidates");

// Unknown preferred falls back to catalog order (recommended first).
const fallback = modelCandidates(gemini, "totally-unknown");
assert.equal(fallback[0].id, "gemini-3.5-flash-lite", "unknown preference falls back to first recommended");

// NVIDIA: the previously-shipped default and the reported model are retired and
// must never be auto-selected; the default must be a current catalog model.
const nvidia = getProviderDef("NVIDIA")!;
assert.equal(getCatalogModel("NVIDIA", "qwen/qwen2.5-coder-32b-instruct")?.deprecated, true, "qwen2.5-coder is flagged retired");
assert.equal(getCatalogModel("NVIDIA", "meta/llama-3.3-70b-instruct")?.deprecated, true, "llama-3.3-70b is flagged retired");
assert.equal(getCatalogModel("NVIDIA", nvidia.defaultModel)?.deprecated ?? false, false, "NVIDIA default is a current (non-retired) model");
const nvCands = modelCandidates(nvidia, "qwen/qwen2.5-coder-32b-instruct");
assert.ok(!nvCands.some((m) => m.deprecated), "no retired NVIDIA model is auto-tried");
assert.equal(nvCands[0].id, nvidia.defaultModel, "retired preference falls back to the current default");

console.log(`ai-providers self-check: OK (${ids.length} providers, ${gemini.catalog.length} gemini models, ${nvidia.catalog.length} nvidia models)`);
