"use client";

// MOHD.HMS ENTERPRISE — Settings → AI Configuration tab (central multi-provider
// AI config spec §2/§3/§5/§6/§7/§8/§16/§17). Lives inside the existing Settings
// module — no separate application, no new top-level menu.
//
// Security properties (spec §3/§30):
//   • The stored credential is NEVER displayed — only a server-provided masked
//     hint (••••••••1234). Show/Hide applies only to the value being typed.
//   • The key lives only in this component's transient state until saved/tested;
//     it is never written to localStorage/sessionStorage and never logged.
//   • Status is authoritative from the backend; the UI never fabricates
//     "Connected" (spec §7).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  Sparkles,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

type ModelMeta = {
  id: string;
  label: string;
  recommended: boolean;
  deprecated: boolean;
  contextTokens?: number;
  capabilities?: string[];
};
type ProviderMeta = {
  id: string;
  label: string;
  requiresKey: boolean;
  defaultModel: string;
  supportsDiscovery: boolean;
  endpoint: string;
  docsUrl: string;
  capabilities: string[];
  models: ModelMeta[];
};
type ProfileView = {
  provider: string;
  label: string;
  requiresKey: boolean;
  configured: boolean;
  hasActiveKey: boolean;
  hasPendingKey: boolean;
  maskedKey: string;
  pendingKeyMasked: string;
  model: string;
  testedModel: string;
  enabled: boolean;
  status: string;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastSuccessAt: string | null;
  lastErrorCode: string;
  lastErrorMessage: string;
  updatedAt: string;
};
type ConfigView = {
  enabled: boolean;
  defaultProvider: string;
  fallbackChain: string[];
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  updatedByEmail: string;
  updatedAt: string;
  providers: ProviderMeta[];
  profiles: ProfileView[];
};

/** Normalize Float artifacts (0.4000000059604645 → 0.4) for display + dirty compare. */
const normTemp = (v: number) => Math.round(v * 100) / 100;

function fmtDateTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return value;
  }
}

/** Honest status → label + tone (spec §7 state machine, mirrors AiConnectionStatus). */
function statusView(status: string): { label: string; tone: string; kind: "ok" | "warn" | "bad" | "idle" } {
  switch (status) {
    case "CONNECTED":
      return { label: "Connected", tone: "bg-emerald-500", kind: "ok" };
    case "SAVED_NOT_TESTED":
      return { label: "Saved — not tested", tone: "bg-amber-500", kind: "warn" };
    case "TESTING":
      return { label: "Testing…", tone: "bg-amber-500", kind: "warn" };
    case "AUTH_FAILED":
      return { label: "Authentication failed — check the credential", tone: "bg-red-500", kind: "bad" };
    case "MODEL_UNAVAILABLE":
      return { label: "Model unavailable", tone: "bg-red-500", kind: "bad" };
    case "RATE_LIMITED":
      return { label: "Rate limited — try again", tone: "bg-amber-500", kind: "warn" };
    case "QUOTA_ISSUE":
      return { label: "Quota exceeded", tone: "bg-red-500", kind: "bad" };
    case "SERVICE_UNAVAILABLE":
      return { label: "Provider unavailable", tone: "bg-red-500", kind: "bad" };
    case "FAILED":
      return { label: "Connection failed", tone: "bg-red-500", kind: "bad" };
    case "NOT_CONFIGURED":
      return { label: "Not configured", tone: "bg-zinc-400", kind: "idle" };
    default:
      return { label: status || "Unknown", tone: "bg-zinc-400", kind: "idle" };
  }
}

export function AiTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.settings_manage);

  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string>("");
  const [enabled, setEnabled] = useState(true);
  const [defaultProvider, setDefaultProvider] = useState("ZAI_PLATFORM");
  const [fallback, setFallback] = useState<string[]>([]);
  const [temperature, setTemperature] = useState("0.4");
  const [maxOutputTokens, setMaxOutputTokens] = useState("2048");
  const [timeoutSec, setTimeoutSec] = useState("30");

  const [model, setModel] = useState("");
  const [profileEnabled, setProfileEnabled] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [discovered, setDiscovered] = useState<ModelMeta[]>([]);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);

  const load = useCallback(
    async (keepSelection = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<ConfigView>("/api/v1/settings/ai");
        const d = res.data;
        setCfg(d);
        setEnabled(d.enabled);
        setDefaultProvider(d.defaultProvider);
        setFallback(d.fallbackChain ?? []);
        setTemperature(String(normTemp(d.temperature ?? 0.4)));
        setMaxOutputTokens(String(d.maxOutputTokens ?? 2048));
        setTimeoutSec(String(Math.round((d.timeoutMs ?? 30000) / 1000)));
        const nextSel = keepSelection && selected ? selected : d.defaultProvider;
        setSelected(nextSel);
        const p = d.profiles.find((x) => x.provider === nextSel);
        setModel(p?.model ?? "");
        setProfileEnabled(p?.enabled ?? true);
        setKeyInput("");
        setShowKey(false);
        setDiscovered([]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to load AI configuration.");
      } finally {
        setLoading(false);
      }
    },
    [selected]
  );

  useEffect(() => {
    void load();
  }, []);

  const profile = useMemo(() => cfg?.profiles.find((p) => p.provider === selected) ?? null, [cfg, selected]);
  const providerMeta = useMemo(() => cfg?.providers.find((p) => p.id === selected) ?? null, [cfg, selected]);

  const selectProvider = (id: string) => {
    setSelected(id);
    const p = cfg?.profiles.find((x) => x.provider === id);
    setModel(p?.model ?? "");
    setProfileEnabled(p?.enabled ?? true);
    setKeyInput("");
    setShowKey(false);
    setDiscovered([]);
  };

  const dirty = useMemo(() => {
    if (!cfg || !profile) return false;
    return (
      enabled !== cfg.enabled ||
      defaultProvider !== cfg.defaultProvider ||
      fallback.join(",") !== (cfg.fallbackChain ?? []).join(",") ||
      temperature !== String(normTemp(cfg.temperature)) ||
      maxOutputTokens !== String(cfg.maxOutputTokens) ||
      timeoutSec !== String(Math.round(cfg.timeoutMs / 1000)) ||
      model !== (profile.model ?? "") ||
      profileEnabled !== profile.enabled ||
      keyInput.trim().length > 0
    );
  }, [cfg, profile, enabled, defaultProvider, fallback, temperature, maxOutputTokens, timeoutSec, model, profileEnabled, keyInput]);

  const save = async () => {
    if (!cfg || !profile || !dirty || saving) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        enabled,
        defaultProvider,
        fallbackChain: fallback,
        temperature: Math.min(2, Math.max(0, Number(temperature) || 0)),
        maxOutputTokens: Math.min(8192, Math.max(64, Number(maxOutputTokens) || 2048)),
        timeoutMs: Math.min(120000, Math.max(5000, (Number(timeoutSec) || 30) * 1000)),
        profile: {
          provider: selected,
          model: model.trim(),
          enabled: profileEnabled,
        },
      };
      const key = keyInput.trim();
      if (providerMeta?.requiresKey && key) {
        if (key.length < 8) {
          toast({ title: "API key looks too short", description: "Paste the full provider credential.", variant: "destructive" });
          setSaving(false);
          return;
        }
        (payload.profile as Record<string, unknown>).apiKey = key;
      }
      await api.put("/api/v1/settings/ai", payload);
      toast({
        title: "AI configuration saved",
        description: key ? "The new credential was stored encrypted. Run Test Connection to activate it." : "Configuration updated.",
      });
      await load(true);
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (testing || saving) return;
    setTesting(true);
    try {
      const res = await api.post<{ ok: boolean; message: string; testedModel?: string; model?: string; status: string }>(
        "/api/v1/settings/ai/test",
        { provider: selected, apiKey: keyInput.trim() || undefined, model: model.trim() || undefined }
      );
      const r = res.data;
      toast({
        title: r.ok ? `${providerMeta?.label ?? selected} connected` : `${providerMeta?.label ?? selected} test failed`,
        description: `${r.message}${r.testedModel || r.model ? ` · model: ${r.testedModel || r.model}` : ""}`,
        variant: r.ok ? "default" : "destructive",
      });
      await load(true);
    } catch (e) {
      toast({ title: "Connection test failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      await load(true);
    } finally {
      setTesting(false);
    }
  };

  const discover = async () => {
    if (discovering) return;
    setDiscovering(true);
    try {
      const res = await api.post<{ ok: boolean; models: ModelMeta[]; source: string; message?: string }>(
        "/api/v1/settings/ai/models",
        { provider: selected, apiKey: keyInput.trim() || undefined }
      );
      setDiscovered(res.data.models ?? []);
      toast({
        title: res.data.ok ? "Live models loaded" : "Live discovery unavailable",
        description: res.data.ok
          ? `${res.data.models.length} model(s) returned by ${providerMeta?.label ?? selected}.`
          : res.data.message ?? "Showing the maintained model list instead.",
        variant: res.data.ok ? "default" : "destructive",
      });
    } catch (e) {
      toast({ title: "Model discovery failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setDiscovering(false);
    }
  };

  const toggleEnabled = async (next: boolean) => {
    if (!cfg || saving) return;
    const previous = enabled;
    setEnabled(next);
    try {
      await api.put("/api/v1/settings/ai", { enabled: next });
      toast({ title: next ? "AI enabled" : "AI disabled", description: next ? "AI features can use the central configuration again." : "AI features will now report that AI is unavailable." });
      await load(true);
    } catch (e) {
      setEnabled(previous);
      toast({ title: "Could not update AI status", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const toggleFallback = (id: string, on: boolean) => {
    setFallback((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  };

  if (loading && !cfg) return <LoadingState label="Loading AI configuration…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!cfg || !profile) return null;

  const sv = testing ? { label: "Testing…", tone: "bg-amber-500", kind: "warn" as const } : statusView(profile.status);
  const modelOptions = [...(providerMeta?.models ?? []), ...discovered.filter((d) => !(providerMeta?.models ?? []).some((m) => m.id === d.id))];
  const fallbackChoices = cfg.providers.filter((p) => p.id !== defaultProvider && p.id !== "ZAI_PLATFORM");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" /> AI Configuration
          </CardTitle>
          <CardDescription>
            One central AI configuration for the entire application. Every AI feature calls the backend AI
            service, which uses the selected provider. Credentials are encrypted at rest and never exposed to
            the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg border p-3 space-y-1">
              <div className="text-xs text-muted-foreground">AI Status</div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 font-medium text-sm">
                  <span className={`h-2 w-2 rounded-full ${cfg.enabled ? "bg-emerald-500" : "bg-zinc-400"}`} aria-hidden />
                  {cfg.enabled ? "Enabled" : "Disabled"}
                </span>
                {canManage ? (
                  <Switch checked={enabled} onCheckedChange={(v) => void toggleEnabled(v)} disabled={saving || testing} aria-label="Enable or disable AI" />
                ) : null}
              </div>
            </div>
            <div className="rounded-lg border p-3 space-y-1">
              <div className="text-xs text-muted-foreground">Connection Status — {profile.label}</div>
              <div className="flex items-center gap-2 text-sm font-medium">
                {sv.kind === "ok" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
                ) : sv.kind === "bad" ? (
                  <XCircle className="h-4 w-4 text-red-600" aria-hidden />
                ) : (
                  <span className={`h-2 w-2 rounded-full ${sv.tone}`} aria-hidden />
                )}
                {sv.label}
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden /> : null}
              </div>
              {profile.lastErrorMessage ? <p className="text-xs text-muted-foreground">{profile.lastErrorMessage}</p> : null}
            </div>
          </div>

          <Separator />

          {/* Provider tabs */}
          <div className="space-y-2">
            <Label>Configured providers</Label>
            <div className="flex flex-wrap gap-2">
              {cfg.profiles.map((p) => {
                const ps = statusView(p.status);
                const active = p.provider === selected;
                return (
                  <button
                    key={p.provider}
                    type="button"
                    onClick={() => selectProvider(p.provider)}
                    disabled={testing}
                    className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${active ? "border-primary bg-primary/5 font-medium" : "hover:bg-muted"}`}
                  >
                    <span className={`h-2 w-2 rounded-full ${ps.kind === "ok" ? "bg-emerald-500" : ps.kind === "bad" ? "bg-red-500" : ps.kind === "warn" ? "bg-amber-500" : "bg-zinc-400"}`} aria-hidden />
                    {p.label}
                    {p.provider === cfg.defaultProvider ? <Badge variant="secondary" className="ml-1">Default</Badge> : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Global provider + fallback */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ai-default-provider">Default provider</Label>
              <Select value={defaultProvider} onValueChange={setDefaultProvider} disabled={!canManage || saving || testing}>
                <SelectTrigger id="ai-default-provider" aria-label="Default AI provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cfg.providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Used first for every AI request.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Fallback providers</Label>
              <div className="flex flex-wrap gap-2 pt-1">
                {fallbackChoices.map((p) => {
                  const on = fallback.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleFallback(p.id, !on)}
                      disabled={!canManage || saving || testing}
                      className={`rounded-md border px-2.5 py-1 text-xs ${on ? "border-primary bg-primary/5 font-medium" : "text-muted-foreground hover:bg-muted"}`}
                    >
                      {on ? "✓ " : "+ "}{p.label}
                    </button>
                  );
                })}
                {fallbackChoices.length === 0 ? <span className="text-xs text-muted-foreground">No other providers.</span> : null}
              </div>
              <p className="text-xs text-muted-foreground">Tried in order if the default provider fails (never fabricates a result).</p>
            </div>
          </div>

          <Separator />

          {/* Selected profile */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ai-model">Model — {providerMeta?.label}</Label>
              <Select value={model || undefined} onValueChange={setModel} disabled={!canManage || saving || testing}>
                <SelectTrigger id="ai-model" aria-label="AI model">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}{m.recommended ? " (recommended)" : ""}{m.deprecated ? " (deprecated)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2 pt-0.5">
                {providerMeta?.supportsDiscovery ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => void discover()} disabled={discovering || saving || testing}>
                    {discovering ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                    Load live models
                  </Button>
                ) : null}
                <p className="text-xs text-muted-foreground">Auto-adjusted to a working model during Test Connection.</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Provider enabled</Label>
              <div className="flex items-center gap-2 pt-1.5">
                <Switch checked={profileEnabled} onCheckedChange={setProfileEnabled} disabled={!canManage || saving || testing} aria-label="Enable this provider" />
                <span className="text-sm text-muted-foreground">{profileEnabled ? "Included in the AI chain" : "Excluded from the AI chain"}</span>
              </div>
            </div>
          </div>

          {/* Credential */}
          {providerMeta?.requiresKey ? (
            <div className="space-y-1.5">
              <Label htmlFor="ai-key">{providerMeta.label} API Key</Label>
              <div className="flex gap-2">
                <Input
                  id="ai-key"
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={profile.maskedKey ? `Stored: ${profile.maskedKey} — enter a new key to replace it` : "Paste the API key"}
                  disabled={!canManage || saving || testing}
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <Button type="button" variant="outline" size="icon" onClick={() => setShowKey((s) => !s)} disabled={!keyInput} aria-label={showKey ? "Hide key while typing" : "Show key while typing"}>
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {profile.maskedKey ? (
                  <>Stored credential: <span className="font-mono">{profile.maskedKey}</span> (encrypted at rest — the full key is never displayed or returned).</>
                ) : (
                  "No credential stored yet. The key is encrypted with AES-256-GCM before storage and is never displayed again."
                )}
              </p>
              {profile.hasPendingKey ? (
                <p className="text-xs text-amber-600">
                  Pending credential <span className="font-mono">{profile.pendingKeyMasked}</span> saved — run Test Connection to activate it. The
                  previous credential stays active until then.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {providerMeta.endpoint} · <a className="underline" href={providerMeta.docsUrl} target="_blank" rel="noreferrer">provider docs</a>
              </p>
            </div>
          ) : null}

          {/* Parameters */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ai-temperature">Temperature</Label>
              <Input id="ai-temperature" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} disabled={!canManage || saving || testing} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-max-tokens">Max output tokens</Label>
              <Input id="ai-max-tokens" type="number" min={64} max={8192} step={64} value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(e.target.value)} disabled={!canManage || saving || testing} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-timeout">Timeout (seconds)</Label>
              <Input id="ai-timeout" type="number" min={5} max={120} step={1} value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} disabled={!canManage || saving || testing} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-muted-foreground">
            <div className="flex justify-between gap-2 sm:block">
              <span className="block">Last Tested</span>
              <span className="font-medium text-foreground">{fmtDateTime(profile.lastTestedAt)}</span>
            </div>
            <div className="flex justify-between gap-2 sm:block">
              <span className="block">Last Successful Use</span>
              <span className="font-medium text-foreground">{fmtDateTime(profile.lastSuccessAt)}</span>
            </div>
            <div className="flex justify-between gap-2 sm:block">
              <span className="block">Last Updated</span>
              <span className="font-medium text-foreground">
                {fmtDateTime(cfg.updatedAt)}{cfg.updatedByEmail ? ` · ${cfg.updatedByEmail}` : ""}
              </span>
            </div>
          </div>

          {canManage ? (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
              <Button onClick={() => void save()} disabled={!dirty || saving || testing}>
                {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
                {saving ? "Saving…" : "Save Configuration"}
              </Button>
              <Button variant="outline" onClick={() => void testConnection()} disabled={saving || testing}>
                {testing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <PlugZap className="h-4 w-4 mr-1.5" />}
                {testing ? "Testing…" : "Test Connection"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void load(true)} disabled={saving || testing}>
                <RefreshCw className="h-4 w-4 mr-1.5" /> Reload
              </Button>
              {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground pt-2 border-t">Read-only — ask an administrator to change AI configuration.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">How this configuration is used</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1.5">
          <p>
            All AI-powered features — checklist generation, inspection report drafting, HR letter drafting and
            future assistants — call the central backend AI service, which loads this configuration, decrypts the
            credential in server memory and calls the selected provider (with fallback). No feature holds its own key.
          </p>
          <p>
            When AI is disabled or not configured, AI features say so honestly and never fabricate output. AI
            results are always draft suggestions a qualified human reviews before use.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
