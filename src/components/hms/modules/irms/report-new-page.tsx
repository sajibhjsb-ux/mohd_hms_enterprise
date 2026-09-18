"use client";

// MOHD.HMS ENTERPRISE — dedicated New Inspection Report page (irms/reports view).
// Routing: #/irms/reports/new. Replaces the former report-create dialog.
// Keeps the existing draft architecture (useDraft "irms.report.create") with a
// restore banner, the exact validation rules (project + title required, no
// empty finding rows) and the ref degradation behavior (equipment options fall
// back to null/"Unavailable" on 403 — kept from the dialog). Findings sub-rows
// stay component state exactly as before (they were never part of the draft).
// Success → the report's dedicated detail page. No new APIs.

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { fmtDateTime } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, FileText, Loader2, Plus, Trash2 } from "lucide-react";

// ── Types / constants (same as the old dialog) ──

type FindingDraft = { finding: string; severity: string; recommendation: string };
type Option = { id: string; label: string };

type ProjectLite = { id: string; code: string; name: string };
type EquipmentLite = { id: string; name: string; assetTag: string };

const REPORT_TYPES = ["ROUTINE", "SAFETY", "EQUIPMENT", "PROJECT", "OTHER"];
const CONDITIONS = ["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const emptyReportForm = {
  projectId: "",
  equipmentId: "",
  title: "",
  type: "ROUTINE",
  inspectionDate: "",
  overallCondition: "GOOD",
  summary: "",
  recommendations: "",
};

// ── Page ──

export function IrmsReportNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.irms_manage);

  const reportDraft = useDraft<typeof emptyReportForm>({ formKey: "irms.report.create", initial: emptyReportForm });
  const [findings, setFindings] = useState<FindingDraft[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Projects (required — the report must link to one) ──
  const [projects, setProjects] = useState<ProjectLite[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setProjectsError(null);
    try {
      const res = await api.get<ProjectLite[]>(`/api/v1/irms/projects${qs({ pageSize: 200 })}`);
      setProjects(res.data ?? []);
    } catch (e) {
      setProjects(null);
      setProjectsError(e instanceof Error ? e.message : "Projects are unavailable.");
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // ── Equipment refs — degrade to null options on failure/403 (kept behavior) ──
  const [equipmentOptions, setEquipmentOptions] = useState<Option[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<EquipmentLite[]>(`/api/v1/equipment${qs({ pageSize: 200 })}`)
      .then((r) => {
        if (!alive) return;
        setEquipmentOptions(((r.data ?? []) as EquipmentLite[]).map((e) => ({
          id: e.id,
          label: `${e.name} (${e.assetTag})`,
        })));
      })
      .catch(() => { if (alive) setEquipmentOptions(null); });
    return () => { alive = false; };
  }, []);

  // Dirty-state wiring (draft fields + findings rows) for the central guard.
  const findingsDirty = findings.some((f) => f.finding.trim() || f.recommendation.trim() || f.severity !== "MEDIUM");
  useEffect(() => {
    setPageDirty(reportDraft.dirty || findingsDirty);
    return () => { setPageDirty(false); };
  }, [reportDraft.dirty, findingsDirty, setPageDirty]);

  // ── Validation (exact rules/messages from the old dialog) ──
  function validate(): boolean {
    if (!reportDraft.value.projectId) {
      toast({ title: "Select a project", variant: "destructive" });
      return false;
    }
    if (!reportDraft.value.title.trim()) {
      toast({ title: "Report title is required", variant: "destructive" });
      return false;
    }
    if (findings.some((f) => !f.finding.trim())) {
      toast({ title: "Some finding rows are empty", description: "Fill or remove empty finding rows.", variant: "destructive" });
      return false;
    }
    return true;
  }

  async function save() {
    if (!validate()) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const v = reportDraft.value;
      const res = await api.post<{ id: string; code: string; title: string }>("/api/v1/irms/reports", {
        projectId: v.projectId,
        equipmentId: v.equipmentId || null,
        title: v.title.trim(),
        type: v.type,
        inspectionDate: v.inspectionDate || null,
        overallCondition: v.overallCondition,
        summary: v.summary.trim(),
        recommendations: v.recommendations.trim(),
        findings: findings
          .filter((f) => f.finding.trim())
          .map((f) => ({ finding: f.finding.trim(), severity: f.severity, recommendation: f.recommendation.trim() })),
      });
      toast({ title: "Report created as draft", description: `${res.data.code} — ${res.data.title}.` });
      reportDraft.reset(emptyReportForm);
      setFindings([]);
      setPageDirty(false);
      // Continue the workflow on the report's dedicated detail page.
      navigateTo("irms", [res.data.id]);
    } catch (e) {
      // Keep every user-entered value on failure — show the error and allow retry.
      const msg = e instanceof Error ? e.message : "Could not create the report. Please try again.";
      setSubmitError(msg);
      toast({ title: "Could not create report", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── RBAC guard ──
  if (!canManage) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="#/irms" title="New Inspection Report">
        <EmptyState
          title="You don't have permission to create inspection reports"
          hint="Creating reports requires the irms.manage permission. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const createButton = (
    <Button onClick={() => void save()} disabled={saving} className="flex-1 sm:flex-none">
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <FileText className="h-4 w-4 mr-1.5" />}
      {saving ? "Creating…" : "Create Draft Report"}
    </Button>
  );

  return (
    <div>
      <PageShell
        backLabel="Back to IRMS" backHref="#/irms"
        crumbs={[{ label: "IRMS", href: "#/irms" }, { label: "New Inspection Report" }]}
        title="New Inspection Report"
        description="Reports start as DRAFT and go through submit → approve."
        actions={<div className="hidden sm:flex items-center gap-2 no-print">{createButton}</div>}
      >
        {/* Recoverable draft banner (same draft as the old dialog) */}
        {reportDraft.draftExists ? (
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-sm no-print">
            <span className="text-muted-foreground">
              Unsubmitted report draft saved{reportDraft.lastSavedAt ? ` ${fmtDateTime(reportDraft.lastSavedAt)}` : " earlier"} — restore it to continue where you left off.
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={reportDraft.restore}>Restore</Button>
              <Button size="sm" variant="ghost" onClick={reportDraft.discard}>Discard</Button>
            </div>
          </div>
        ) : null}

        {submitError ? (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">The report could not be created.</p>
              <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
            </div>
          </div>
        ) : null}

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" aria-hidden /> Report Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {projectsError ? (
              <ErrorState message={`Projects are unavailable — ${projectsError}`} onRetry={() => void loadProjects()} />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Project *</Label>
                  <Select
                    value={reportDraft.value.projectId || undefined}
                    onValueChange={(v) => reportDraft.setValue({ projectId: v })}
                  >
                    <SelectTrigger aria-label="Project">
                      <SelectValue placeholder={projects === null ? "Loading projects…" : projects.length === 0 ? "No projects yet" : "Select project"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(projects ?? []).map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {projects !== null && projects.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No inspection projects yet — create a project first from the IRMS list.
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label>Equipment</Label>
                  <Select
                    value={reportDraft.value.equipmentId || "NONE"}
                    onValueChange={(v) => reportDraft.setValue({ equipmentId: v === "NONE" ? "" : v })}
                    disabled={equipmentOptions === null}
                  >
                    <SelectTrigger aria-label="Equipment"><SelectValue placeholder={equipmentOptions === null ? "Unavailable" : "None"} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">Not equipment-specific</SelectItem>
                      {(equipmentOptions ?? []).map((e) => (
                        <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="ins-title">Title *</Label>
                  <Input
                    id="ins-title"
                    value={reportDraft.value.title}
                    onChange={(e) => reportDraft.setValue({ title: e.target.value })}
                    placeholder="Quarterly HVAC system inspection"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select value={reportDraft.value.type} onValueChange={(v) => reportDraft.setValue({ type: v })}>
                    <SelectTrigger aria-label="Report type"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {REPORT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ins-date">Inspection Date</Label>
                  <Input
                    id="ins-date" type="date"
                    value={reportDraft.value.inspectionDate}
                    onChange={(e) => reportDraft.setValue({ inspectionDate: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Overall Condition</Label>
                  <Select value={reportDraft.value.overallCondition} onValueChange={(v) => reportDraft.setValue({ overallCondition: v })}>
                    <SelectTrigger aria-label="Overall condition"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONDITIONS.map((c) => (
                        <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="ins-summary">Summary</Label>
                  <Textarea
                    id="ins-summary" rows={3}
                    value={reportDraft.value.summary}
                    onChange={(e) => reportDraft.setValue({ summary: e.target.value })}
                    placeholder="Executive summary of the inspection…"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="ins-recs">Recommendations</Label>
                  <Textarea
                    id="ins-recs" rows={3}
                    value={reportDraft.value.recommendations}
                    onChange={(e) => reportDraft.setValue({ recommendations: e.target.value })}
                    placeholder="Corrective actions, follow-ups, next inspection date…"
                  />
                </div>

                {/* Findings sub-rows (same UX as the old dialog) */}
                <div className="sm:col-span-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Findings</Label>
                    <Button
                      type="button" variant="outline" size="sm"
                      onClick={() => setFindings((f) => [...f, { finding: "", severity: "MEDIUM", recommendation: "" }])}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" /> Add Finding
                    </Button>
                  </div>
                  {findings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No findings yet — add rows for each observation.</p>
                  ) : (
                    <div className="space-y-3">
                      {findings.map((f, idx) => (
                        <div key={idx} className="rounded-lg border p-3 space-y-2 bg-muted/20">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-muted-foreground">Finding {idx + 1}</span>
                            <div className="ml-auto">
                              <Button
                                type="button" variant="ghost" size="sm"
                                onClick={() => setFindings((rows) => rows.filter((_, i) => i !== idx))}
                                aria-label={`Remove finding ${idx + 1}`}
                              >
                                <Trash2 className="h-3.5 w-3.5 text-red-600" />
                              </Button>
                            </div>
                          </div>
                          <Textarea
                            rows={2}
                            value={f.finding}
                            onChange={(e) => setFindings((rows) => rows.map((r, i) => (i === idx ? { ...r, finding: e.target.value } : r)))}
                            placeholder="Describe the observation…"
                            aria-label={`Finding ${idx + 1} description`}
                          />
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <Select
                              value={f.severity}
                              onValueChange={(v) => setFindings((rows) => rows.map((r, i) => (i === idx ? { ...r, severity: v } : r)))}
                            >
                              <SelectTrigger aria-label={`Severity for finding ${idx + 1}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {SEVERITIES.map((s) => (
                                  <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Input
                              value={f.recommendation}
                              onChange={(e) => setFindings((rows) => rows.map((r, i) => (i === idx ? { ...r, recommendation: e.target.value } : r)))}
                              placeholder="Recommendation (optional)"
                              aria-label={`Recommendation for finding ${idx + 1}`}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Autosave hint (kept from the old dialog footer) */}
        <p className="mt-3 text-xs text-muted-foreground no-print">
          {reportDraft.dirty || findingsDirty
            ? "Draft auto-saves as you type — safe to leave and restore later (finding rows are kept only for this session)."
            : reportDraft.lastSavedAt
              ? `Draft saved at ${fmtDateTime(reportDraft.lastSavedAt)}.`
              : "Tip: the form auto-saves as a draft while you type."}
        </p>
      </PageShell>

      {/* Sticky mobile action bar */}
      <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          {createButton}
        </div>
      </div>
    </div>
  );
}
