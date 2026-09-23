"use client";

// MOHD.HMS ENTERPRISE — Settings → AI Configuration tab (central AI config
// spec §2/§3/§7/§8/§16/§17/§18/§31/§32). Lives inside the existing Settings
// module — no separate application, no new top-level menu.
//
// Security properties (spec §3/§30):
//   • The stored credential is NEVER displayed — only a server-provided
//     masked hint (••••••••1234). Show/Hide applies only to the value
//     currently being typed.
//   • The key lives only in this component's transient state until saved;
//     it is never written to localStorage/sessionStorage and never logged.
//   • Save → encrypted server-side; Test Connection → real provider request.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Eye, EyeOff, Loader2, PlugZap, RefreshCw, Save, Sparkles, XCircle } from "lucide-react";
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

type AiConfigView = {
  provider: "ZAI_PLATFORM" | "GOOGLE_GEMINI";
  providerLabel: string;
  providerRequiresKey: boolean;
  configured: boolean;
  enabled: boolean;
  model: string;
  maskedKey: string;
  hasPendingKey: boolean;
  pendingKeyMasked: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  status: string; // NOT_CONFIGURED | CONFIGURED | ACTIVE | FAILED
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastErrorCode: string;
  lastErrorMessage: string;
  updatedByEmail: string;
  updatedAt: string;
};

const GEMINI_MODEL_HINT = "Current Google-supported models include gemini-2.5-flash, gemini-2.5-pro and gemini-2.0-flash.";

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

export function AiTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.settings_manage);

  const [cfg, setCfg] = useState<AiConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editable state.
  const [provider, setProvider] = useState<AiConfigView["provider"]>("ZAI_PLATFORM");
  const [enabled, setEnabled] = useState(true);
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState("0.4");
  const [maxOutputTokens, setMaxOutputTokens] = useState("2048");
  const [timeoutSec, setTimeoutSec] = useState("30");
  // Key entry — transient, never persisted client-side (spec §3).
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<AiConfigView>("/api/v1/settings/ai");
      setCfg(res.data);
      setProvider(res.data.provider);
      setEnabled(res.data.enabled);
      setModel(res.data.model ?? "");
      setTemperature(String(normTemp(res.data.temperature ?? 0.4)));
      setMaxOutputTokens(String(res.data.maxOutputTokens ?? 2048));
      setTimeoutSec(String(Math.round((res.data.timeoutMs ?? 30000) / 1000)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load AI configuration.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!cfg) return false;
    return (
      provider !== cfg.provider ||
      enabled !== cfg.enabled ||
      model !== (cfg.model ?? "") ||
      temperature !== String(normTemp(cfg.temperature)) ||
      maxOutputTokens !== String(cfg.maxOutputTokens) ||
      timeoutSec !== String(Math.round(cfg.timeoutMs / 1000)) ||
      keyInput.trim().length > 0
    );
  }, [cfg, provider, enabled, model, temperature, maxOutputTokens, timeoutSec, keyInput]);

  const save = async () => {
    if (!cfg || !dirty || saving) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        provider,
        enabled,
        model: provider === "GOOGLE_GEMINI" ? model.trim() : "",
        temperature: Math.min(2, Math.max(0, Number(temperature) || 0)),
        maxOutputTokens: Math.min(8192, Math.max(64, Number(maxOutputTokens) || 2048)),
        timeoutMs: Math.min(120000, Math.max(5000, (Number(timeoutSec) || 30) * 1000)),
      };
      const key = keyInput.trim();
      if (provider === "GOOGLE_GEMINI" && key) {
        if (key.length < 20) {
          toast({ title: "API key looks too short", description: "Paste the full Gemini API credential.", variant: "destructive" });
          setSaving(false);
          return;
        }
        payload.apiKey = key;
      }
      await api.put("/api/v1/settings/ai", payload);
      setKeyInput("");
      setShowKey(false);
      toast({
        title: "AI configuration saved",
        description: key ? "The new credential was stored encrypted. Run Test Connection to activate it." : "Configuration updated.",
      });
      await load();
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
      const res = await api.post<{ ok: boolean; message: string; model: string; durationMs: number }>("/api/v1/settings/ai/test");
      toast({
        title: res.data.ok ? "Gemini connection successful" : "Gemini connection failed",
        description: `${res.data.message}${res.data.model ? ` · model: ${res.data.model}` : ""}`,
        variant: res.data.ok ? "default" : "destructive",
      });
      await load();
    } catch (e) {
      toast({ title: "Connection test failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      await load();
    } finally {
      setTesting(false);
    }
  };

  const toggleEnabled = async (next: boolean) => {
    if (!cfg || saving) return;
    const previous = enabled;
    setEnabled(next);
    try {
      await api.put("/api/v1/settings/ai", { enabled: next });
      toast({ title: next ? "AI enabled" : "AI disabled", description: next ? "All AI features can use the central configuration again." : "All AI features will now report that AI is unavailable." });
      await load();
    } catch (e) {
      setEnabled(previous);
      toast({ title: "Could not update AI status", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  if (loading) return <LoadingState label="Loading AI configuration…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!cfg) return null;

  // Connection status view-model (spec §7/§31 states).
  const statusView = (() => {
    if (testing) return { label: "Testing…", tone: "bg-amber-500", badge: "outline" as const };
    if (!cfg.enabled) return { label: "Disabled", tone: "bg-zinc-400", badge: "secondary" as const };
    if (cfg.status === "ACTIVE") return { label: "Connected", tone: "bg-emerald-500", badge: "default" as const };
    if (cfg.status === "FAILED") return { label: "Authentication Failed", tone: "bg-red-500", badge: "destructive" as const };
    if (cfg.status === "CONFIGURED") return { label: "Configured — not tested", tone: "bg-amber-500", badge: "outline" as const };
    return { label: "Not Configured", tone: "bg-zinc-400", badge: "outline" as const };
  })();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" /> AI Configuration
          </CardTitle>
          <CardDescription>
            One central AI configuration for the entire application. Every AI-powered feature uses this
            credential through the backend AI service — the key is encrypted at rest and never exposed to
            the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Status rows */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg border p-3 space-y-1">
              <div className="text-xs text-muted-foreground">AI Status</div>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 font-medium text-sm`}>
                  <span className={`h-2 w-2 rounded-full ${cfg.enabled ? "bg-emerald-500" : "bg-zinc-400"}`} aria-hidden />
                  {cfg.enabled ? "Enabled" : "Disabled"}
                </span>
                {canManage ? (
                  <Switch
                    checked={enabled}
                    onCheckedChange={(v) => void toggleEnabled(v)}
                    disabled={saving || testing}
                    aria-label="Enable or disable AI"
                  />
                ) : null}
              </div>
            </div>
            <div className="rounded-lg border p-3 space-y-1">
              <div className="text-xs text-muted-foreground">Connection Status</div>
              <div className="flex items-center gap-2 text-sm font-medium">
                {statusView.label === "Connected" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
                ) : statusView.label === "Authentication Failed" ? (
                  <XCircle className="h-4 w-4 text-red-600" aria-hidden />
                ) : (
                  <span className={`h-2 w-2 rounded-full ${statusView.tone}`} aria-hidden />
                )}
                {statusView.label}
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden /> : null}
              </div>
              {cfg.lastErrorMessage ? (
                <p className="text-xs text-muted-foreground">{cfg.lastErrorMessage}</p>
              ) : null}
            </div>
          </div>

          <Separator />

          {/* Provider */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ai-provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={(v) => setProvider(v as AiConfigView["provider"])}
                disabled={!canManage || saving || testing}
              >
                <SelectTrigger id="ai-provider" aria-label="AI provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GOOGLE_GEMINI">Google Gemini</SelectItem>
                  <SelectItem value="ZAI_PLATFORM">Built-in Z.ai Platform</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {provider === "GOOGLE_GEMINI"
                  ? "Uses the Gemini API credential below — encrypted server-side."
                  : "Platform-managed AI — no external credential required."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ai-model">Model</Label>
              <Input
                id="ai-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={provider === "GOOGLE_GEMINI" ? "gemini-2.5-flash" : "Platform-managed"}
                disabled={!canManage || saving || testing || provider !== "GOOGLE_GEMINI"}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">{provider === "GOOGLE_GEMINI" ? GEMINI_MODEL_HINT : "The model is selected by the platform."}</p>
            </div>
          </div>

          {/* Credential — Gemini only */}
          {provider === "GOOGLE_GEMINI" ? (
            <div className="space-y-1.5">
              <Label htmlFor="ai-key">Gemini API Key</Label>
              <div className="flex gap-2">
                <Input
                  id="ai-key"
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={cfg.maskedKey ? `Stored: ${cfg.maskedKey} — enter a new key to replace it` : "Paste the Gemini API key"}
                  disabled={!canManage || saving || testing}
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowKey((s) => !s)}
                  disabled={!keyInput}
                  aria-label={showKey ? "Hide key while typing" : "Show key while typing"}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {cfg.maskedKey ? (
                  <>
                    Stored credential: <span className="font-mono">{cfg.maskedKey}</span> (encrypted at rest — the full key is never displayed or returned).
                  </>
                ) : (
                  "No credential stored yet. The key is encrypted with AES-256-GCM before storage and is never displayed again."
                )}
              </p>
              {cfg.hasPendingKey ? (
                <p className="text-xs text-amber-600">
                  Pending credential <span className="font-mono">{cfg.pendingKeyMasked}</span> saved — run Test Connection to activate it. The
                  previous credential stays active until then.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Parameters */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ai-temperature">Temperature</Label>
              <Input
                id="ai-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                disabled={!canManage || saving || testing}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-max-tokens">Max output tokens</Label>
              <Input
                id="ai-max-tokens"
                type="number"
                min={64}
                max={8192}
                step={64}
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(e.target.value)}
                disabled={!canManage || saving || testing}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-timeout">Timeout (seconds)</Label>
              <Input
                id="ai-timeout"
                type="number"
                min={5}
                max={120}
                step={1}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
                disabled={!canManage || saving || testing}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div className="flex justify-between gap-2 sm:block">
              <span className="block">Last Tested</span>
              <span className="font-medium text-foreground">{fmtDateTime(cfg.lastTestedAt)}</span>
            </div>
            <div className="flex justify-between gap-2 sm:block">
              <span className="block">Last Updated</span>
              <span className="font-medium text-foreground">
                {fmtDateTime(cfg.updatedAt)}
                {cfg.updatedByEmail ? ` · ${cfg.updatedByEmail}` : ""}
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
              <Button variant="ghost" size="sm" onClick={() => void load()} disabled={saving || testing}>
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
            All AI-powered features in the application — checklist generation, inspection report drafting, HR
            letter drafting and future assistants — call the central backend AI service, which loads this
            configuration, decrypts the credential in server memory and calls the provider. No feature holds
            its own key.
          </p>
          <p>
            When AI is disabled or not configured, AI features state so honestly and never fabricate output.
            AI results are always draft suggestions that a qualified human reviews before use.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
