"use client";

// MOHD.HMS ENTERPRISE — Email administration (Email Configuration module).
// Canonical location for ALL email configuration: Overview (health, SMTP
// status, test tools, configuration), plus Templates / Automations / Logs
// panels gated by their own permissions. Owned by the dedicated Email
// Configuration module — the general Settings page has no email controls.

import { useCallback, useEffect, useState } from "react";
import { Activity, Building2, KeyRound, Mail, Plug, RefreshCw, Save, Send } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmailAutomations } from "./email-automations";
import { EmailLogs } from "./email-logs";
import { EmailTemplates } from "./email-templates";
import { MailboxesAdmin } from "./email-mailboxes";

type EmailHealth = {
  sentToday: number;
  failedToday: number;
  queued: number;
  retrying: number;
  lastSuccess: { at: string; to: string; subject: string } | null;
  lastFailure: { at: string; to: string; error: string } | null;
  smtp: {
    configured: boolean;
    host: string | null;
    port: number | null;
    security: string | null;
    lastVerifyAt: string | null;
    lastVerifyOk: boolean | null;
  };
};

type EmailConfig = {
  provider: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: string;
  smtpUser: string | null;
  hasPassword: boolean;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  timeoutMs: number | null;
  testRecipient: string | null;
};

type EmailMeta = {
  templates?: { key: string; name: string; category?: string | null }[];
  categories?: string[];
  moduleMailboxes?: { key: string; label: string; value: string }[];
};

type ConfigDraft = {
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: string;
  smtpUser: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  timeoutMs: string;
  testRecipient: string;
};

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function configToDraft(c: EmailConfig): ConfigDraft {
  return {
    smtpHost: c.smtpHost ?? "",
    smtpPort: c.smtpPort == null ? "" : String(c.smtpPort),
    smtpSecurity: c.smtpSecurity || "NONE",
    smtpUser: c.smtpUser ?? "",
    fromName: c.fromName ?? "",
    fromEmail: c.fromEmail ?? "",
    replyTo: c.replyTo ?? "",
    timeoutMs: c.timeoutMs == null ? "" : String(c.timeoutMs),
    testRecipient: c.testRecipient ?? "",
  };
}

export function EmailTab() {
  const { user } = useSession();
  const canView = hasPerm(user, PERMISSIONS.email_view); // guaranteed by the parent gate — checked defensively
  const canConfig = hasPerm(user, PERMISSIONS.email_config);
  const canTemplates = hasPerm(user, PERMISSIONS.email_templates);
  const canAutomations = hasPerm(user, PERMISSIONS.email_automations);

  return (
    <Tabs defaultValue="overview">
      <TabsList className="mb-4 flex-wrap">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        {canConfig ? <TabsTrigger value="mailboxes">Mailboxes</TabsTrigger> : null}
        {canTemplates ? <TabsTrigger value="templates">Templates</TabsTrigger> : null}
        {canAutomations ? <TabsTrigger value="automations">Automations</TabsTrigger> : null}
        {canView ? <TabsTrigger value="logs">Logs</TabsTrigger> : null}
      </TabsList>

      <TabsContent value="overview">
        <OverviewPanel />
      </TabsContent>
      {canConfig ? (
        <TabsContent value="mailboxes">
          <MailboxesAdmin />
        </TabsContent>
      ) : null}
      {canTemplates ? (
        <TabsContent value="templates">
          <EmailTemplates />
        </TabsContent>
      ) : null}
      {canAutomations ? (
        <TabsContent value="automations">
          <EmailAutomations />
        </TabsContent>
      ) : null}
      {canView ? (
        <TabsContent value="logs">
          <EmailLogs />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Overview — health, SMTP status, test tools, configuration                   */
/*────────────────────────────────────────────────────────────────────────────*/

function OverviewPanel() {
  const { user } = useSession();
  const { toast } = useToast();
  const canConfig = hasPerm(user, PERMISSIONS.email_config);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<EmailHealth | null>(null);
  const [meta, setMeta] = useState<EmailMeta>({});
  const [config, setConfig] = useState<EmailConfig | null>(null);
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearingPw, setClearingPw] = useState(false);
  const [testing, setTesting] = useState(false);
  const [conn, setConn] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testTo, setTestTo] = useState("");
  const [templateSel, setTemplateSel] = useState("none");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const healthRes = await api.get<EmailHealth>("/api/v1/email/health");
      setHealth(healthRes.data);
      if (canConfig) {
        const [cfgRes, metaRes] = await Promise.all([
          api.get<EmailConfig>("/api/v1/email/config"),
          api.get<EmailMeta>("/api/v1/email/meta").catch(() => ({ data: {} as EmailMeta })),
        ]);
        setConfig(cfgRes.data);
        setDraft(configToDraft(cfgRes.data));
        setTestTo((prev) => prev || cfgRes.data?.testRecipient || "");
        setMeta(metaRes.data ?? {});
      } else {
        // Read-only role — meta (module mailboxes) is best effort.
        const metaRes = await api.get<EmailMeta>("/api/v1/email/meta").catch(() => ({ data: null as EmailMeta | null }));
        if (metaRes.data) setMeta(metaRes.data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load email overview.");
    } finally {
      setLoading(false);
    }
  }, [canConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveConfig = async () => {
    if (!draft) return;
    const portNum = draft.smtpPort.trim() === "" ? null : Number(draft.smtpPort);
    const timeoutNum = draft.timeoutMs.trim() === "" ? null : Number(draft.timeoutMs);
    if (portNum !== null && (!Number.isFinite(portNum) || portNum <= 0)) {
      toast({ title: "Invalid SMTP port", description: "The port must be a positive number.", variant: "destructive" });
      return;
    }
    if (timeoutNum !== null && (!Number.isFinite(timeoutNum) || timeoutNum <= 0)) {
      toast({ title: "Invalid timeout", description: "The timeout must be a positive number of milliseconds.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        // Empty strings CLEAR a stored value — the PATCH schema rejects nulls
        // for these fields (only smtpPassword accepts an explicit null).
        smtpHost: draft.smtpHost.trim(),
        smtpSecurity: draft.smtpSecurity,
        smtpUser: draft.smtpUser.trim(),
        fromName: draft.fromName.trim(),
        fromEmail: draft.fromEmail.trim(),
        replyTo: draft.replyTo.trim(),
        testRecipient: draft.testRecipient.trim(),
      };
      if (portNum !== null) payload.smtpPort = portNum;
      if (timeoutNum !== null) payload.timeoutMs = timeoutNum;
      // The stored password is never read back — only sent when freshly typed.
      if (password.trim() !== "") payload.smtpPassword = password;
      await api.patch("/api/v1/email/config", payload);
      setPassword("");
      toast({ title: "Email configuration saved" });
      await load();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const clearPassword = async () => {
    setClearingPw(true);
    try {
      await api.patch("/api/v1/email/config", { smtpPassword: null });
      setPassword("");
      toast({ title: "Stored password cleared", description: "The next delivery attempt will fail until a new password is saved." });
      await load();
    } catch (e) {
      toast({ title: "Could not clear password", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setClearingPw(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setConn(null);
    try {
      const res = await api.post<{ ok: boolean; detail: string }>("/api/v1/email/config/test-connection", {});
      const ok = res.data?.ok === true;
      const detail = res.data?.detail ?? (ok ? "Connected." : "Connection failed.");
      setConn({ ok, detail });
      if (ok) toast({ title: "SMTP connection successful", description: detail });
      else toast({ title: "SMTP connection failed", description: detail, variant: "destructive" });
    } catch (e) {
      const detail = e instanceof Error ? e.message : "Connection test failed.";
      setConn({ ok: false, detail });
      toast({ title: "SMTP connection failed", description: detail, variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const sendTest = async () => {
    const to = testTo.trim();
    if (!to) {
      toast({ title: "Recipient required", description: "Enter the address that should receive the test email.", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const res = await api.post<{ ok: boolean; detail: string; logId?: string }>("/api/v1/email/config/test-send", {
        to,
        templateId: templateSel !== "none" ? templateSel : undefined,
      });
      const ok = res.data?.ok === true;
      const detail = res.data?.detail ?? (ok ? `Queued for ${to}.` : "The provider rejected the message.");
      if (ok) toast({ title: "Test email sent", description: detail + (res.data?.logId ? ` (log ${res.data.logId.slice(0, 8)}…)` : "") });
      else toast({ title: "Test email failed", description: detail, variant: "destructive" });
    } catch (e) {
      toast({ title: "Test email failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  if (loading) return <LoadingState label="Loading email overview…" />;
  if (error || !health) return <ErrorState message={error ?? "Unknown error."} onRetry={() => void load()} />;

  const smtp = health.smtp;
  const mailboxes = meta.moduleMailboxes ?? [];

  return (
    <div className="space-y-4">
      {/* Delivery health (real counters — "—" when nothing happened yet) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" /> Delivery health
          </CardTitle>
          <CardDescription>Live counters from the email queue and delivery log — today (server time).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: "Sent today", value: health.sentToday, tone: "text-emerald-600" },
              { label: "Failed today", value: health.failedToday, tone: health.failedToday > 0 ? "text-red-600" : "text-muted-foreground" },
              { label: "Queued", value: health.queued, tone: health.queued > 0 ? "text-amber-600" : "text-muted-foreground" },
              { label: "Retrying", value: health.retrying, tone: health.retrying > 0 ? "text-amber-600" : "text-muted-foreground" },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className={"text-2xl font-semibold tabular-nums " + c.tone}>{c.value}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-lg border p-2.5">
              <p className="text-muted-foreground mb-0.5">Last success</p>
              {health.lastSuccess ? (
                <p className="text-foreground">
                  {when(health.lastSuccess.at)} · {health.lastSuccess.to} · <span className="text-muted-foreground">{health.lastSuccess.subject}</span>
                </p>
              ) : (
                <p className="text-muted-foreground">—</p>
              )}
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-muted-foreground mb-0.5">Last failure</p>
              {health.lastFailure ? (
                <p className="text-red-700 break-words">
                  {when(health.lastFailure.at)} · {health.lastFailure.to} · {health.lastFailure.error}
                </p>
              ) : (
                <p className="text-muted-foreground">—</p>
              )}
            </div>
          </div>
          <div>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* SMTP status */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-4 w-4 text-primary" /> SMTP status
          </CardTitle>
          <CardDescription>
            {smtp.configured
              ? "Outgoing mail server used by every notification and automated email."
              : "Not configured — emails are queued but cannot be delivered until SMTP is set up."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Server</p>
              <p className="font-medium font-mono text-xs">{smtp.host ? `${smtp.host}:${smtp.port ?? 25}` : "—"}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Security</p>
              <p className="font-medium font-mono text-xs">{smtp.security ?? "—"}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Last verification</p>
              <p className="font-medium text-xs flex flex-wrap items-center gap-1.5">
                {smtp.lastVerifyAt ? (
                  <>
                    {when(smtp.lastVerifyAt)}
                    {smtp.lastVerifyOk === true ? (
                      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">OK</Badge>
                    ) : smtp.lastVerifyOk === false ? (
                      <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">Failed</Badge>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </p>
            </div>
          </div>
          {canConfig ? (
            <div className="space-y-1.5">
              <Button variant="outline" size="sm" data-testid="email-test-connection" disabled={testing} onClick={() => void testConnection()}>
                <Plug className={"h-3.5 w-3.5 mr-1.5" + (testing ? " animate-pulse" : "")} /> {testing ? "Testing…" : "Test connection"}
              </Button>
              {conn ? (
                <p className={"text-xs " + (conn.ok ? "text-emerald-700" : "text-red-700")}>
                  {conn.ok ? "SMTP connection successful" : "SMTP connection failed"} — {conn.detail}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Connection testing requires the email configuration permission.</p>
          )}
        </CardContent>
      </Card>

      {/* Send test email */}
      {canConfig ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Send className="h-4 w-4 text-primary" /> Send test email
            </CardTitle>
            <CardDescription>Renders a template with sample data and delivers it to one recipient — the result appears in the log.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="email-test-to">Recipient</Label>
                <Input id="email-test-to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="name@company.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email-test-template">Template (optional)</Label>
                <Select value={templateSel} onValueChange={setTemplateSel}>
                  <SelectTrigger id="email-test-template"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Default test email</SelectItem>
                    {(meta.templates ?? []).map((t) => (
                      <SelectItem key={t.key} value={t.key}>
                        <span className="font-mono text-xs">{t.key}</span> — {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button data-testid="email-test-send" disabled={sending} onClick={() => void sendTest()}>
              <Send className="h-4 w-4 mr-1.5" /> {sending ? "Sending…" : "Send test email"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Configuration */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4 text-primary" /> Email configuration
          </CardTitle>
          <CardDescription>
            {canConfig
              ? "Provider and SMTP transport for every outgoing email. The password is write-only — it is never sent back to the browser."
              : "Read-only — ask an administrator to change the email configuration."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canConfig && draft && config ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-provider">Provider</Label>
                  <Input id="cfg-provider" value={config.provider ?? ""} disabled />
                  <p className="text-xs text-muted-foreground">Provider is fixed in this deployment.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-security">SMTP security</Label>
                  <Select value={draft.smtpSecurity} onValueChange={(v) => setDraft((d) => d && ({ ...d, smtpSecurity: v }))}>
                    <SelectTrigger id="cfg-security"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">NONE</SelectItem>
                      <SelectItem value="SSL">SSL</SelectItem>
                      <SelectItem value="STARTTLS">STARTTLS</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-host">SMTP host</Label>
                  <Input id="cfg-host" value={draft.smtpHost} onChange={(e) => setDraft((d) => d && ({ ...d, smtpHost: e.target.value }))} placeholder="smtp.company.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-port">SMTP port</Label>
                  <Input id="cfg-port" type="number" value={draft.smtpPort} onChange={(e) => setDraft((d) => d && ({ ...d, smtpPort: e.target.value }))} placeholder="587" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-user">SMTP user</Label>
                  <Input id="cfg-user" value={draft.smtpUser} onChange={(e) => setDraft((d) => d && ({ ...d, smtpUser: e.target.value }))} placeholder="notifications@company.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-password">SMTP password</Label>
                  <div className="flex gap-2">
                    <Input
                      id="cfg-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={config.hasPassword ? "Stored — leave blank to keep" : "Not set"}
                      autoComplete="new-password"
                    />
                    {config.hasPassword ? (
                      <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" disabled={clearingPw} onClick={() => void clearPassword()}>
                        <KeyRound className="h-3.5 w-3.5 mr-1" /> Clear stored
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">Write-only — blank keeps the stored password.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-from-name">From name</Label>
                  <Input id="cfg-from-name" value={draft.fromName} onChange={(e) => setDraft((d) => d && ({ ...d, fromName: e.target.value }))} placeholder="MOHD.HMS Enterprise" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-from-email">From email</Label>
                  <Input id="cfg-from-email" type="email" value={draft.fromEmail} onChange={(e) => setDraft((d) => d && ({ ...d, fromEmail: e.target.value }))} placeholder="noreply@company.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-reply-to">Reply-To</Label>
                  <Input id="cfg-reply-to" type="email" value={draft.replyTo} onChange={(e) => setDraft((d) => d && ({ ...d, replyTo: e.target.value }))} placeholder="support@company.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-timeout">Timeout (ms)</Label>
                  <Input id="cfg-timeout" type="number" value={draft.timeoutMs} onChange={(e) => setDraft((d) => d && ({ ...d, timeoutMs: e.target.value }))} placeholder="15000" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cfg-test-recipient">Test recipient</Label>
                  <Input id="cfg-test-recipient" type="email" value={draft.testRecipient} onChange={(e) => setDraft((d) => d && ({ ...d, testRecipient: e.target.value }))} placeholder="admin@company.com" />
                  <p className="text-xs text-muted-foreground">Pre-fills the test email recipient above.</p>
                </div>
              </div>
              <div className="border-t pt-3">
                <Button data-testid="email-config-save" disabled={saving} onClick={() => void saveConfig()}>
                  <Save className="h-4 w-4 mr-1.5" /> {saving ? "Saving…" : "Save configuration"}
                </Button>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg border p-2.5"><p className="text-xs text-muted-foreground">Configured</p><p className="font-medium">{smtp.configured ? "Yes" : "No"}</p></div>
              <div className="rounded-lg border p-2.5"><p className="text-xs text-muted-foreground">Server</p><p className="font-medium font-mono text-xs">{smtp.host ? `${smtp.host}:${smtp.port ?? 25}` : "—"}</p></div>
              <div className="rounded-lg border p-2.5"><p className="text-xs text-muted-foreground">Security</p><p className="font-medium font-mono text-xs">{smtp.security ?? "—"}</p></div>
              <div className="rounded-lg border p-2.5"><p className="text-xs text-muted-foreground">Last verification</p><p className="font-medium">{smtp.lastVerifyAt ? when(smtp.lastVerifyAt) : "—"}</p></div>
              <p className="text-xs text-muted-foreground sm:col-span-2">Full configuration editing requires the email configuration permission.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Module mailboxes — read-only; owned by the Company tab */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4 text-primary" /> Module mailboxes
          </CardTitle>
          <CardDescription>Per-module sender addresses used by automations (recipient rule “MODULE_MAILBOX”).</CardDescription>
        </CardHeader>
        <CardContent>
          {mailboxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No module mailboxes defined.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {mailboxes.map((m) => (
                <div key={m.key} className="flex items-center justify-between gap-3 rounded-lg border p-2.5 text-sm">
                  <span className="font-medium">{m.label}</span>
                  <span className="font-mono text-xs text-muted-foreground truncate">{m.value}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2">These addresses come from company settings — edit them in the Company tab.</p>
        </CardContent>
      </Card>
    </div>
  );
}
