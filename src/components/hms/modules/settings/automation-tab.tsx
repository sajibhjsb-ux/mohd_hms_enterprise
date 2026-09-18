"use client";

// MOHD.HMS ENTERPRISE — Automation admin panel (§63 AUTOMATION ADMIN PANEL,
// §64 FAILED AUTOMATION UI, §103/§104). Lives inside the existing Settings module —
// no separate application. All KPIs come from real engine data (outbox + runs).

import { useCallback, useEffect, useState } from "react";
import { Activity, Bot, RefreshCw, Save, Settings2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type LastRun = { result: string; startedAt: string; detail: string } | null;

type Overview = {
  events: { pending: number; done: number; processing: number; dead: number };
  runs24h: Record<string, number>;
  automations: { key: string; label: string; enabled: boolean; heartbeatAt?: string | null; lastRun: LastRun; success: number; failed: number }[];
  failedRuns: { id: string; eventId: string; workflow: string; detail: string; startedAt: string; eventType: string; resourceType: string; resourceId: string; eventStatus: string }[];
  deadLetters: { id: string; type: string; resourceType: string; resourceId: string; attempts: number; maxAttempts: number; lastError: string; createdAt: string }[];
  settings: Record<string, string>;
};

const TOGGLES: { key: string; label: string; hint: string }[] = [
  { key: "auto_invoice_on_confirm", label: "Auto draft invoice on customer confirmation", hint: "Confirmed complaint with billable work → one draft invoice for Finance review." },
  { key: "auto_invoice_on_wo_complete", label: "Auto draft invoice on standalone work order completion", hint: "Billable work orders without a complaint are invoiced automatically." },
  { key: "auto_work_order_on_accept", label: "Auto work order on complaint acceptance", hint: "Technician acceptance creates a pending work order when none exists." },
  { key: "auto_pm_task_generation", label: "Automatic PM task generation & reminders", hint: "Scheduler generates due PM tasks and sends configurable reminders." },
  { key: "low_stock_alerts", label: "Low stock alerts", hint: "Notify admins/supervisors when stock reaches minimum (deduplicated)." },
  { key: "escalation_engine", label: "Escalation engine", hint: "Unaccepted complaints and long-running work orders escalate to supervisors." },
  { key: "sla_engine", label: "SLA engine", hint: "Track response targets per priority and report breaches." },
  { key: "invoice_overdue_automation", label: "Invoice overdue automation", hint: "Past-due invoices are marked OVERDUE and Finance is notified." },
  { key: "email_notifications", label: "Email notification queue", hint: "Queued emails are delivered to the notification log (provider integration point)." },
  { key: "whatsapp_notifications", label: "WhatsApp notifications", hint: "Requires a configured provider — events are recorded when disabled." },
  { key: "push_notifications", label: "Push notifications", hint: "Requires Firebase configuration." },
];

const NUMBERS: { key: string; label: string; hint: string }[] = [
  { key: "complaint_accept_escalation_hours", label: "Complaint acceptance escalation (hours)", hint: "How long a complaint may stay assigned before escalating." },
  { key: "wo_overdue_escalation_days", label: "Work order running-long escalation (days)", hint: "Days in progress before supervisor escalation." },
  { key: "pm_reminder_days", label: "PM reminder days (comma separated)", hint: "Days before PM due date to remind the technician." },
];

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function AutomationTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const isSuper = user?.role === "SUPER_ADMIN";
  const canManage = hasPerm(user, PERMISSIONS.settings_manage);

  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Overview>("/api/v1/automation/overview");
      setData(res.data);
      setDraft(res.data.settings ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load automation overview.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = data ? Object.entries(draft).filter(([k, v]) => (data.settings[k] ?? "") !== v) : [];

  const save = async () => {
    if (!dirty.length) return;
    setSaving(true);
    try {
      await api.put("/api/v1/automation/settings", { settings: Object.fromEntries(dirty) });
      toast({ title: "Automation settings saved", description: `${dirty.length} setting(s) updated. The engine picks them up within a minute.` });
      await load();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const retry = async (eventId: string) => {
    setRetrying(eventId);
    try {
      await api.post(`/api/v1/automation/events/${eventId}/retry`, {});
      toast({ title: "Event re-queued", description: "The outbox worker will process it shortly. Idempotency prevents duplicates." });
      await load();
    } catch (e) {
      toast({ title: "Retry failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setRetrying(null);
    }
  };

  if (loading) return <LoadingState label="Loading automation overview…" />;
  if (error || !data) return <ErrorState message={error ?? "Unknown error."} onRetry={() => void load()} />;

  return (
    <div className="space-y-4" data-testid="automation-panel">
      {/* Engine health (§104) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Queued jobs", value: data.events.pending, tone: "text-amber-600" },
          { label: "Completed (total)", value: data.events.done, tone: "text-emerald-600" },
          { label: "Dead-lettered", value: data.events.dead, tone: data.events.dead > 0 ? "text-red-600" : "text-muted-foreground" },
          { label: "Runs last 24h", value: (data.runs24h["SUCCESS"] ?? 0) + (data.runs24h["SKIPPED"] ?? 0) + (data.runs24h["FAILED"] ?? 0), tone: "" },
        ].map((c) => (
          <Card key={c.label}>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className={`text-2xl font-semibold ${c.tone}`} data-testid={`automation-${c.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{c.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Automations status (§63) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" /> Automations
          </CardTitle>
          <CardDescription>Live status from the workflow engine — last run, 24h outcomes, enabled state.</CardDescription>
        </CardHeader>
        <CardContent className="max-h-96 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Automation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Last run</TableHead>
                <TableHead className="text-right">24h ✓ / ✗</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.automations.map((a) => (
                <TableRow key={a.key}>
                  <TableCell className="font-medium">{a.label}</TableCell>
                  <TableCell>
                    {a.enabled ? (
                      <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200" variant="outline">Running</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">Off</Badge>
                    )}
                    {a.key === "outbox_worker" && a.heartbeatAt ? (
                      <span className="ml-2 text-[10px] text-muted-foreground">tick {new Date(a.heartbeatAt).toLocaleTimeString("en-GB")}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                    {a.lastRun ? (
                      <>
                        <span className={a.lastRun.result === "SUCCESS" ? "text-emerald-700" : a.lastRun.result === "FAILED" ? "text-red-700" : ""}>{a.lastRun.result}</span>
                        {" · "}{when(a.lastRun.startedAt)}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    <span className="text-emerald-700">{a.success}</span> / <span className={a.failed > 0 ? "text-red-700" : ""}>{a.failed}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Failed runs + dead letters (§64) */}
      {(data.failedRuns.length > 0 || data.deadLetters.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4 text-destructive" /> Failed automation jobs
            </CardTitle>
            <CardDescription>
              Failed runs and dead-lettered events. Retry is {isSuper ? "available and idempotent" : "restricted to the super administrator"}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 max-h-96 overflow-y-auto">
            {data.failedRuns.map((r) => (
              <div key={r.id} className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-red-700 border-red-200">{r.workflow}</Badge>
                  <span className="text-xs text-muted-foreground">{r.eventType} · {r.resourceType} {r.resourceId.slice(0, 12)}… · {when(r.startedAt)}</span>
                  {isSuper ? (
                    <Button size="sm" variant="outline" className="ml-auto h-7" disabled={retrying === r.eventId} onClick={() => void retry(r.eventId)}>
                      <RefreshCw className="h-3 w-3 mr-1" /> {retrying === r.eventId ? "Retrying…" : "Retry workflow run"}
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-destructive break-all">{r.detail}</p>
              </div>
            ))}
            {data.deadLetters.map((e) => (
              <div key={e.id} className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/20 p-3 text-sm space-y-1" data-testid="dead-letter">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-red-300 text-red-800">DEAD · {e.type}</Badge>
                  <span className="text-xs text-muted-foreground">{e.resourceType} {e.resourceId.slice(0, 12)}… · {e.attempts}/{e.maxAttempts} attempts · {when(e.createdAt)}</span>
                  {isSuper ? (
                    <Button size="sm" variant="outline" className="ml-auto h-7" disabled={retrying === e.id} onClick={() => void retry(e.id)}>
                      <RefreshCw className="h-3 w-3 mr-1" /> {retrying === e.id ? "Retrying…" : "Retry event"}
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-red-800 break-all">{e.lastError}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Settings (§36/§103) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2 className="h-4 w-4 text-primary" /> Automation settings
          </CardTitle>
          <CardDescription>
            {canManage ? "Changes are audited and take effect within one minute." : "Read-only — administrators can change these settings."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-3">
            {TOGGLES.map((t) => (
              <div key={t.key} className="flex items-start justify-between gap-4 rounded-lg border p-3">
                <div>
                  <Label htmlFor={`auto-${t.key}`} className="text-sm font-medium">{t.label}</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.hint}</p>
                </div>
                <Switch
                  id={`auto-${t.key}`}
                  checked={(draft[t.key] ?? "") === "on"}
                  disabled={!canManage}
                  onCheckedChange={(on) => setDraft((d) => ({ ...d, [t.key]: on ? "on" : "off" }))}
                />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {NUMBERS.map((n) => (
              <div key={n.key} className="space-y-1.5">
                <Label htmlFor={`auto-${n.key}`} className="text-sm font-medium">{n.label}</Label>
                <Input
                  id={`auto-${n.key}`}
                  value={draft[n.key] ?? ""}
                  disabled={!canManage}
                  onChange={(e) => setDraft((d) => ({ ...d, [n.key]: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">{n.hint}</p>
              </div>
            ))}
          </div>
          {canManage ? (
            <div className="flex items-center gap-3 border-t pt-3">
              <Button onClick={() => void save()} disabled={saving || dirty.length === 0}>
                <Save className="h-4 w-4 mr-1.5" /> {saving ? "Saving…" : "Save settings"}
              </Button>
              {dirty.length > 0 ? <span className="text-sm text-muted-foreground">{dirty.length} unsaved change(s)</span> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
