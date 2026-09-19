"use client";

// Settings module — Company settings (DB-backed key/value config) + System info
// (app/version, live health checks, database note, session info).

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Database, Globe2, Info, Save, Server, ShieldCheck, XCircle } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { PERMISSIONS, LOCALIZATION } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { ErrorState, LoadingState, PageHeader } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AutomationTab } from "./automation-tab";
import { EmailTab } from "./email-tab";
import { LegalTab } from "./legal-tab";
import { WhatsAppTab } from "./whatsapp-tab";

// Keep in sync with package.json version.
const APP_VERSION = "0.2.1";

type FieldDef = { key: string; label: string; textarea?: boolean; type?: string; placeholder?: string };

const COMPANY_FIELDS: FieldDef[] = [
  { key: "company_name", label: "Company Name", placeholder: "MOHD.HMS Enterprise" },
  { key: "company_country", label: "Country", placeholder: "Brunei Darussalam" },
  { key: "company_phone", label: "Phone", placeholder: "+673 234-5678" },
  { key: "company_address", label: "Address", textarea: true },
  { key: "company_email_info", label: "Info Email", type: "email" },
  { key: "company_email_sales", label: "Sales Email", type: "email" },
  { key: "company_email_service", label: "Service Email", type: "email" },
  { key: "company_email_finance", label: "Finance Email", type: "email" },
  { key: "company_email_hr", label: "HR Email", type: "email" },
  { key: "company_email_procurement", label: "Procurement Email", type: "email" },
  { key: "company_email_inspection", label: "Inspection Email", type: "email" },
  { key: "tax_percent_default", label: "Default Tax (%)", placeholder: "6" },
  { key: "currency", label: "Currency (BND)", placeholder: "BND" },
  { key: "public_url", label: "Public Website URL", placeholder: "https://www.mohdhms.com" },
  { key: "invoice_terms", label: "Invoice Terms", textarea: true },
  { key: "quotation_terms", label: "Quotation Terms", textarea: true },
];

type HealthResult = { ok: boolean; statusText: string; detail: string; at: string } | null;

export function SettingsModule() {
  const { user } = useSession();
  const { toast } = useToast();

  const canManage = hasPerm(user, PERMISSIONS.settings_manage);
  // Email admin area (§30) — only visible to roles holding the email view permission.
  const canViewEmail = hasPerm(user, PERMISSIONS.email_view);
  // WhatsApp admin area (§8) — only visible to roles holding the WhatsApp view permission.
  const canViewWhatsApp = hasPerm(user, PERMISSIONS.whatsapp_view);

  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [live, setLive] = useState<HealthResult>(null);
  const [ready, setReady] = useState<HealthResult>(null);
  const [checking, setChecking] = useState<"live" | "ready" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Record<string, string>>("/api/v1/settings");
      const map: Record<string, string> = {};
      for (const field of COMPANY_FIELDS) map[field.key] = res.data?.[field.key] ?? "";
      setValues(map);
      setSaved(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const changedKeys = useMemo(
    () => COMPANY_FIELDS.filter((f) => (values[f.key] ?? "") !== (saved[f.key] ?? "")).map((f) => f.key),
    [values, saved]
  );

  const save = async () => {
    if (changedKeys.length === 0) {
      toast({ title: "No changes to save", description: "Edit a field first, then save." });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const key of changedKeys) payload[key] = values[key] ?? "";
      await api.put("/api/v1/settings", { values: payload });
      setSaved({ ...values });
      toast({ title: "Settings saved", description: `${changedKeys.length} value${changedKeys.length === 1 ? "" : "s"} updated.` });
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async (kind: "live" | "ready") => {
    setChecking(kind);
    const path = kind === "live" ? "/api/health" : "/api/health/ready";
    const at = new Date().toLocaleTimeString("en-GB");
    try {
      const res = await fetch(path, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; status?: string; checks?: Record<string, string> } | null;
      const detail = body
        ? `${body.status ?? (body.ok ? "ok" : "error")}${body.checks?.database ? ` · database: ${body.checks.database}` : ""}`
        : "No response body";
      const result: HealthResult = { ok: res.ok && body?.ok !== false, statusText: `HTTP ${res.status}`, detail, at };
      if (kind === "live") setLive(result);
      else setReady(result);
    } catch (e) {
      const result: HealthResult = {
        ok: false,
        statusText: "Network error",
        detail: e instanceof Error ? e.message : "fetch failed",
        at,
      };
      if (kind === "live") setLive(result);
      else setReady(result);
    } finally {
      setChecking(null);
    }
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle="Company configuration and system information" />

      <Tabs defaultValue="company">
        <TabsList className="mb-4 flex-wrap h-auto">
          <TabsTrigger value="company">Company</TabsTrigger>
          <TabsTrigger value="localization">Localization</TabsTrigger>
          <TabsTrigger value="automation">Automation</TabsTrigger>
          {canViewEmail ? <TabsTrigger value="email">Email</TabsTrigger> : null}
          {canViewWhatsApp ? <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger> : null}
          <TabsTrigger value="legal">Legal</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        {/* ── Company ── */}
        <TabsContent value="company">
          {loading ? (
            <LoadingState label="Loading settings…" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Company Profile</CardTitle>
                <CardDescription>
                  {canManage
                    ? "These details appear on invoices, quotations and customer-facing documents."
                    : "Read-only — ask an administrator to change company settings."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {COMPANY_FIELDS.map((field) => (
                    <div
                      key={field.key}
                      className={field.textarea ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}
                    >
                      <Label htmlFor={`setting-${field.key}`}>{field.label}</Label>
                      {field.textarea ? (
                        <Textarea
                          id={`setting-${field.key}`}
                          rows={3}
                          disabled={!canManage}
                          value={values[field.key] ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                        />
                      ) : (
                        <Input
                          id={`setting-${field.key}`}
                          type={field.type ?? "text"}
                          disabled={!canManage}
                          value={values[field.key] ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                        />
                      )}
                    </div>
                  ))}
                </div>

                {canManage ? (
                  <div className="flex items-center gap-3 pt-2 border-t">
                    <Button onClick={() => void save()} disabled={saving || changedKeys.length === 0}>
                      <Save className="h-4 w-4 mr-1.5" /> {saving ? "Saving…" : "Save Changes"}
                    </Button>
                    {changedKeys.length > 0 ? (
                      <span className="text-sm text-muted-foreground">
                        {changedKeys.length} unsaved change{changedKeys.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Localization (§26 — centralized application localization settings) ── */}
        <TabsContent value="localization">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Globe2 className="h-4 w-4 text-primary" /> Localization — Brunei Darussalam
              </CardTitle>
              <CardDescription>
                System-wide localization is fixed to Brunei Darussalam. The business currency does not
                follow the user&apos;s browser location. Financial settings can only be changed by authorized
                administrators.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Country</span><span className="font-medium">{LOCALIZATION.country}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Country code</span><span className="font-medium">{LOCALIZATION.countryCode}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Currency</span><span className="font-medium">{LOCALIZATION.currencyCode} ({LOCALIZATION.currencySymbol})</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Currency format</span><span className="font-medium tabular-nums">BND 1,250.00</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Locale</span><span className="font-medium">{LOCALIZATION.locale}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Timezone</span><span className="font-medium">{LOCALIZATION.timezone}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Phone country code</span><span className="font-medium">{LOCALIZATION.phoneCode}</span></div>
              <p className="text-xs text-muted-foreground pt-2 border-t">
                All financial modules, documents and notifications use the centralized BND formatter.
                Amounts are stored as exact integer cents — no floating-point arithmetic.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Automation (§63/§104 — inside the existing Settings architecture) ── */}
        <TabsContent value="automation">
          <AutomationTab />
        </TabsContent>

        {/* ── Email (§30 — centralized EmailService administration) ── */}
        {canViewEmail ? (
          <TabsContent value="email">
            <EmailTab />
          </TabsContent>
        ) : null}

        {/* ── WhatsApp (§8 — centralized WhatsApp/OpenWA administration) ── */}
        {canViewWhatsApp ? (
          <TabsContent value="whatsapp">
            <WhatsAppTab />
          </TabsContent>
        ) : null}

        {/* ── Legal (Terms & Conditions / Privacy Policy — canonical versions) ── */}
        <TabsContent value="legal">
          <LegalTab />
        </TabsContent>

        {/* ── System ── */}
        <TabsContent value="system">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Info className="h-4 w-4 text-primary" /> Application
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">App</span>
                  <span className="font-medium">MOHD.HMS ENTERPRISE</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Version</span>
                  <span className="font-medium">v{APP_VERSION}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Environment</span>
                  <Badge variant="outline">Sandbox</Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-4 w-4 text-primary" /> Session
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Signed in as</span>
                  <span className="font-medium truncate max-w-[60%] text-right">{user?.email ?? "—"}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Name</span>
                  <span className="font-medium">{user?.name ?? "—"}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Role</span>
                  <Badge variant="outline" className="font-medium">{user?.role ?? "—"}</Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Server className="h-4 w-4 text-primary" /> Health Checks
                </CardTitle>
                <CardDescription>Live endpoint checks — no simulation, real requests.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {([
                  { kind: "live" as const, label: "GET /api/health", result: live },
                  { kind: "ready" as const, label: "GET /api/health/ready", result: ready },
                ]).map(({ kind, label, result }) => (
                  <div key={kind} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border p-3">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{label}</code>
                    <div className="flex items-center gap-2 sm:ml-auto">
                      {result ? (
                        <>
                          {result.ok ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-600" aria-hidden />
                          )}
                          <span className="text-xs text-muted-foreground" title={result.detail}>
                            {result.statusText} · {result.detail} · {result.at}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not checked yet</span>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={checking !== null}
                        onClick={() => void runCheck(kind)}
                      >
                        {checking === kind ? "Checking…" : "Run check"}
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Database className="h-4 w-4 text-primary" /> Database
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                SQLite via Prisma (sandbox) — PostgreSQL in production deployment.
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
