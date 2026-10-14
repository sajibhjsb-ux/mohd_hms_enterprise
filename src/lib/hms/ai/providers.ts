// MOHD.HMS ENTERPRISE — AI provider + model registry (central AI config spec §2/§3/§4).
//
// This is the ONE place that describes the supported providers, their
// authentication model, their documented endpoint, their capabilities and a
// maintained server-side model catalog. Transport/HTTP logic lives in
// ./service.ts (adapters); features never reference providers directly.
//
// HONESTY RULE (spec §3/§6): a model appearing in the catalog means only that
// it is a documented provider model — NOT that the configured credential can
// use it. Only a real, validated Test Connection produces a CONNECTED state.
// When a provider exposes a model-listing API, discovery is preferred and the
// catalog is only a fallback.

export type AiProviderId = "GOOGLE_GEMINI" | "ANTHROPIC_CLAUDE" | "OPENAI" | "NVIDIA" | "ZAI_PLATFORM";

export type AiModelCapability = "text" | "image" | "document" | "json" | "tools" | "streaming";

export type AiModelInfo = {
  id: string;
  label: string;
  provider: AiProviderId;
  /** True when the provider documents this as a current general-purpose model. */
  recommended?: boolean;
  /** Provider-documented as deprecated/superseded — shown, never auto-picked. */
  deprecated?: boolean;
  contextTokens?: number;
  capabilities: AiModelCapability[];
};

export type AiProviderDef = {
  id: AiProviderId;
  label: string;
  requiresKey: boolean;
  /** Provider-documented default model used when the admin leaves the field blank. */
  defaultModel: string;
  /** Documented API base used by the adapter (NVIDIA is OpenAI-compatible). */
  endpoint: string;
  /** OpenAPI/docs reference shown to administrators. */
  docsUrl: string;
  supportsDiscovery: boolean;
  /** Catalog order is also the deterministic order used by auto-test. */
  catalog: AiModelInfo[];
  capabilities: AiModelCapability[];
};

const TEXT_JSON: AiModelCapability[] = ["text", "json"];

export const AI_PROVIDERS: AiProviderDef[] = [
  {
    id: "GOOGLE_GEMINI",
    label: "Google Gemini",
    requiresKey: true,
    defaultModel: "gemini-3.5-flash-lite",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    docsUrl: "https://ai.google.dev/api/generate-content",
    supportsDiscovery: true,
    capabilities: ["text", "json", "image", "tools", "streaming"],
    catalog: [
      // Current general-purpose models (verified reachable). Discovery +
      // Test Connection still validate against the live API before use.
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", provider: "GOOGLE_GEMINI", recommended: true, contextTokens: 1_048_576, capabilities: ["text", "json", "image", "tools", "streaming"] },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", provider: "GOOGLE_GEMINI", recommended: true, contextTokens: 1_048_576, capabilities: ["text", "json", "image", "tools", "streaming"] },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "GOOGLE_GEMINI", contextTokens: 1_048_576, capabilities: ["text", "json", "image", "tools", "streaming"] },
      // Superseded — shown for transparency, never auto-selected.
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (retired)", provider: "GOOGLE_GEMINI", deprecated: true, contextTokens: 1_048_576, capabilities: ["text", "json", "image", "tools", "streaming"] },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (retired)", provider: "GOOGLE_GEMINI", deprecated: true, contextTokens: 1_048_576, capabilities: ["text", "json", "image", "tools", "streaming"] },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (retired)", provider: "GOOGLE_GEMINI", deprecated: true, contextTokens: 1_048_576, capabilities: ["text", "json"] },
    ],
  },
  {
    id: "ANTHROPIC_CLAUDE",
    label: "Anthropic Claude",
    requiresKey: true,
    defaultModel: "claude-3-5-haiku-latest",
    endpoint: "https://api.anthropic.com/v1",
    docsUrl: "https://docs.anthropic.com/en/api/messages",
    supportsDiscovery: true,
    capabilities: ["text", "json", "image", "tools", "streaming"],
    catalog: [
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku", provider: "ANTHROPIC_CLAUDE", recommended: true, contextTokens: 200_000, capabilities: ["text", "json", "tools", "streaming"] },
      { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet", provider: "ANTHROPIC_CLAUDE", contextTokens: 200_000, capabilities: ["text", "json", "image", "tools", "streaming"] },
      { id: "claude-3-7-sonnet-latest", label: "Claude 3.7 Sonnet", provider: "ANTHROPIC_CLAUDE", contextTokens: 200_000, capabilities: ["text", "json", "image", "tools", "streaming"] },
    ],
  },
  {
    id: "OPENAI",
    label: "OpenAI ChatGPT",
    requiresKey: true,
    defaultModel: "gpt-4o-mini",
    endpoint: "https://api.openai.com/v1",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
    supportsDiscovery: true,
    capabilities: ["text", "json", "image", "tools", "streaming"],
    catalog: [
      { id: "gpt-4o-mini", label: "GPT-4o mini", provider: "OPENAI", recommended: true, contextTokens: 128_000, capabilities: ["text", "json", "image", "tools", "streaming"] },
      { id: "gpt-4o", label: "GPT-4o", provider: "OPENAI", contextTokens: 128_000, capabilities: ["text", "json", "image", "tools", "streaming"] },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", provider: "OPENAI", contextTokens: 1_047_576, capabilities: ["text", "json", "image", "tools", "streaming"] },
      { id: "gpt-4.1", label: "GPT-4.1", provider: "OPENAI", contextTokens: 1_047_576, capabilities: ["text", "json", "image", "tools", "streaming"] },
    ],
  },
  {
    id: "NVIDIA",
    label: "NVIDIA AI (NIM)",
    requiresKey: true,
    // NVIDIA-hosted inference (build.nvidia.com / integrate.api.nvidia.com) —
    // an OpenAI-compatible hosted endpoint, NOT a self-hosted NIM container.
    // Model availability is per-NVIDIA-account and changes over time, so
    // discovery + a real generation test are authoritative; this catalog is a
    // maintained fallback only. Retired endpoints are kept visible but flagged
    // so they are never auto-selected.
    defaultModel: "nvidia/nemotron-3.5-lightning-30b-a3b",
    endpoint: "https://integrate.api.nvidia.com/v1",
    docsUrl: "https://docs.api.nvidia.com/nim/reference/llm-apis",
    supportsDiscovery: true,
    capabilities: ["text", "json", "streaming"],
    catalog: [
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning 30B", provider: "NVIDIA", recommended: true, contextTokens: 128_000, capabilities: ["text", "json", "streaming"] },
      { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B", provider: "NVIDIA", recommended: true, contextTokens: 128_000, capabilities: ["text", "json", "streaming"] },
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", provider: "NVIDIA", contextTokens: 128_000, capabilities: ["text", "json", "streaming"] },
      { id: "meta/llama-3.2-11b-vision-instruct", label: "Llama 3.2 11B Vision Instruct", provider: "NVIDIA", contextTokens: 128_000, capabilities: ["text", "json", "streaming"] },
      { id: "meta/llama-3.2-90b-vision-instruct", label: "Llama 3.2 90B Vision Instruct", provider: "NVIDIA", contextTokens: 128_000, capabilities: ["text", "json", "streaming"] },
      // Retired endpoints (HTTP 410 end-of-life / 404 not-entitled) — never auto-picked.
      { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct (retired)", provider: "NVIDIA", deprecated: true, contextTokens: 128_000, capabilities: ["text", "json", "streaming"] },
      { id: "meta/llama-3.1-8b-instruct", label: "Llama 3.1 8B Instruct (retired)", provider: "NVIDIA", deprecated: true, contextTokens: 128_000, capabilities: ["text", "json", "streaming"] },
      { id: "nvidia/llama-3.3-nemotron-super-49b-v1", label: "Llama 3.3 Nemotron Super 49B (retired)", provider: "NVIDIA", deprecated: true, contextTokens: 128_000, capabilities: ["text", "json", "streaming"] },
      { id: "qwen/qwen2.5-coder-32b-instruct", label: "Qwen2.5 Coder 32B (retired)", provider: "NVIDIA", deprecated: true, contextTokens: 131_072, capabilities: ["text", "json", "streaming"] },
    ],
  },
  {
    id: "ZAI_PLATFORM",
    label: "Built-in Z.ai Platform",
    requiresKey: false,
    defaultModel: "z-ai-chat",
    endpoint: "",
    docsUrl: "",
    supportsDiscovery: false,
    capabilities: TEXT_JSON,
    catalog: [{ id: "z-ai-chat", label: "Platform default model", provider: "ZAI_PLATFORM", recommended: true, capabilities: TEXT_JSON }],
  },
];

export function getProviderDef(id: string): AiProviderDef | null {
  return AI_PROVIDERS.find((p) => p.id === id) ?? null;
}

export function isAiProviderId(id: string): id is AiProviderId {
  return AI_PROVIDERS.some((p) => p.id === id);
}

/** Providers that accept an administrator-supplied credential. */
export function externalProviders(): AiProviderDef[] {
  return AI_PROVIDERS.filter((p) => p.requiresKey);
}

/** Catalog entry lookup (provider + model id). */
export function getCatalogModel(provider: string, model: string): AiModelInfo | null {
  return getProviderDef(provider)?.catalog.find((m) => m.id === model) ?? null;
}

/**
 * Deterministic candidate order for Test Connection / Auto Select (spec §6):
 * recommended models first (catalog order), then the rest, never deprecated
 * ones automatically. The model already chosen by the admin is tried first.
 */
export function modelCandidates(provider: AiProviderDef, preferred: string): AiModelInfo[] {
  const usable = provider.catalog.filter((m) => !m.deprecated);
  const ordered: AiModelInfo[] = [];
  const push = (m?: AiModelInfo | null) => {
    // A retired/deprecated model is never a candidate, not even the admin's
    // current selection (spec §3 — stop auto-selecting dead endpoints).
    if (!m || m.deprecated || ordered.some((x) => x.id === m.id)) return;
    ordered.push(m);
  };
  push(getCatalogModel(provider.id, preferred));
  for (const m of usable.filter((m) => m.recommended)) push(m);
  for (const m of usable) push(m);
  return ordered;
}
