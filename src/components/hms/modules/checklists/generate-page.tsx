"use client";

// MOHD.HMS ENTERPRISE — AI checklist generation page (§3/§15/§22/§71).
// Pick a source (complaint / work order / PM plan / IRMS report) and either
// generate with AI or pull deterministically from an approved template.

import { useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { PageShell } from "@/components/hms/shared/page-shell";
import { CHECKLIST_SOURCE_TYPES, humanize } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Sparkles, Layers } from "lucide-react";
import { navigateTo } from "@/lib/hms/router";

type SourceOpt = { id: string; code: string; title: string };
type TemplateOpt = { id: string; name: string; category: string; workType: string; itemCount: number };

function loadSources(sourceType: string): Promise<SourceOpt[]> {
  switch (sourceType) {
    case "COMPLAINT": return api.get<SourceOpt[]>("/api/v1/complaints" + qs({ pageSize: 200 })).then((r) => r.data);
    case "WORK_ORDER": return api.get<SourceOpt[]>("/api/v1/work-orders" + qs({ pageSize: 200 })).then((r) => r.data);
    case "PM": return api.get<SourceOpt[]>("/api/v1/pm/plans" + qs({ pageSize: 200 })).then((r) => r.data);
    case "IRMS": return api.get<SourceOpt[]>("/api/v1/irms/reports" + qs({ pageSize: 200 })).then((r) => r.data);
    default: return Promise.resolve([]);
  }
}

export function GenerateChecklistPage() {
  const { toast } = useToast();
  const [sourceType, setSourceType] = useState<string>("WORK_ORDER");
  const [sourceId, setSourceId] = useState<string>("");
  const [sources, setSources] = useState<SourceOpt[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateOpt[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [useTemplate, setUseTemplate] = useState(false);
  const [templateId, setTemplateId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!sourceType) return;
    setSourcesLoading(true);
    setSourcesError(null);
    setSourceId("");
    loadSources(sourceType)
      .then((rows) => { if (alive) setSources(rows); })
      .catch(() => { if (alive) setSourcesError("Could not load sources."); })
      .finally(() => { if (alive) setSourcesLoading(false); });
    return () => { alive = false; };
  }, [sourceType]);

  useEffect(() => {
    let alive = true;
    setTemplatesLoading(true);
    api.get<{ templates: TemplateOpt[] }>("/api/v1/checklists/templates")
      .then((r) => { if (alive) setTemplates(Array.isArray(r.data.templates) ? r.data.templates : []); })
      .catch(() => { /* template fetch is optional */ })
      .finally(() => { if (alive) setTemplatesLoading(false); });
    return () => { alive = false; };
  }, []);

  const selectedSource = useMemo(() => sources.find((s) => s.id === sourceId) ?? null, [sources, sourceId]);

  const submit = async () => {
    if (!sourceId) { toast({ title: "Source required", variant: "destructive" }); return; }
    if (useTemplate && !templateId) { toast({ title: "Template required", variant: "destructive" }); return; }
    setBusy(true);
    try {
      const body = { sourceType, sourceId, ...(useTemplate ? { templateId } : {}) };
      const res = await api.post<{ instanceId: string; code: string; status: string }>(
        useTemplate ? "/api/v1/checklists/from-template" : "/api/v1/checklists/generate",
        body
      );
      toast({ title: "Checklist draft created", description: `${res.data.code} — ${useTemplate ? "from template" : "AI generated"}.` });
      navigateTo("checklists", [res.data.instanceId]);
    } catch (e) {
      toast({ title: "Generation failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell backLabel="Back to Checklists" backHref="/checklists" title="Generate checklist" description="Create a checklist draft for a complaint, work order, PM plan or IRMS report.">
      <Card className="max-w-2xl shadow-sm p-5 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="gc-type">Source type</Label>
            <Select value={sourceType} onValueChange={setSourceType}>
              <SelectTrigger id="gc-type" aria-label="Source type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CHECKLIST_SOURCE_TYPES.map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gc-source">Source record</Label>
            <Select value={sourceId} onValueChange={setSourceId} disabled={sourcesLoading}>
              <SelectTrigger id="gc-source" aria-label="Source record">
                <SelectValue placeholder={sourcesLoading ? "Loading sources…" : "Select a record"} />
              </SelectTrigger>
              <SelectContent>
                {sourcesLoading ? null : sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.code} — {s.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {sourcesError ? <p className="text-xs text-destructive">{sourcesError}</p> : null}
        {selectedSource && !useTemplate ? (
          <p className="text-xs text-muted-foreground">Generating for <span className="font-mono">{selectedSource.code}</span>.</p>
        ) : null}

        <div className="rounded-lg border p-4 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} className="h-4 w-4 rounded border" />
            Use an approved template instead of the AI generator
          </label>
          {useTemplate ? (
            <div className="space-y-1.5">
              <Label htmlFor="gc-template">Template</Label>
              <Select value={templateId} onValueChange={setTemplateId} disabled={templatesLoading}>
                <SelectTrigger id="gc-template" aria-label="Template">
                  <SelectValue placeholder={templatesLoading ? "Loading templates…" : "Select a template"} />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name} ({t.category} · {t.itemCount} tasks)</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={submit} disabled={busy || !sourceId && !useTemplate}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : useTemplate ? <Layers className="h-4 w-4 mr-1.5" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
            {useTemplate ? "Create from template" : "Generate with AI"}
          </Button>
          <Button variant="outline" onClick={() => navigateTo("checklists", [])} disabled={busy}>Cancel</Button>
        </div>
      </Card>
    </PageShell>
  );
}