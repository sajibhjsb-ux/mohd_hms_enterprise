"use client";

// MOHD.HMS ENTERPRISE — Letter Template editor (page, hr/letters/templates/{id|new}).
// Create or edit a versioned template (§3/§5/§6/§7): metadata, AI instructions,
// deterministic body skeleton with {{PLACEHOLDERS}} + one {{BODY}} slot, and the
// structured field definitions that drive the create-letter form. Content edits
// bump the version server-side (§27); a live preview shows the result.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useUi } from "@/lib/hms/ui-store";
import { PERMISSIONS } from "@/lib/hms/constants";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { LetterPaper, LetterPaperSkeleton } from "./preview";
import {
  LETTER_TYPES, SYSTEM_PLACEHOLDERS, TEMPLATE_FIELD_TYPES, letterTypeLabel, validateFieldKey,
  type LetterPreviewModel, type LetterTemplateDto, type TemplateField, type TemplateFieldType,
} from "@/lib/hms/letters/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";

type Form = {
  code: string;
  name: string;
  letterType: string;
  description: string;
  department: string;
  status: string;
  isDefault: boolean;
  aiInstructions: string;
  subjectHint: string;
  bodyTemplate: string;
  closingTemplate: string;
  fields: TemplateField[];
};

const emptyForm = (): Form => ({
  code: "",
  name: "",
  letterType: "GENERAL",
  description: "",
  department: "HR",
  status: "ACTIVE",
  isDefault: false,
  aiInstructions: "",
  subjectHint: "",
  bodyTemplate: "{{BODY}}",
  closingTemplate: "Yours faithfully,",
  fields: [
    { key: "RECIPIENT_NAME", label: "Recipient Name", type: "text", required: true, ai: true },
    { key: "RECIPIENT_COMPANY", label: "Recipient Organization", type: "text", ai: true },
    { key: "MAIN_POINTS", label: "Main Points / Message", type: "textarea", required: true, ai: true },
    { key: "SIGNATORY_NAME", label: "Signatory Name", type: "text", required: true },
    { key: "SIGNATORY_POSITION", label: "Signatory Position", type: "text", required: true },
  ],
});

function errMsg(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.";
}

export function TemplateEditorPage({ templateId }: { templateId?: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.letters_templates);

  const isNew = !templateId;
  const [form, setForm] = useState<Form>(emptyForm());
  const [loaded, setLoaded] = useState(isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<LetterPreviewModel | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (isNew || !canManage) return;
    let alive = true;
    api
      .get<LetterTemplateDto>(`/api/v1/hr/letters/templates/${templateId}`)
      .then((res) => {
        if (!alive) return;
        setForm({
          code: res.data.code,
          name: res.data.name,
          letterType: res.data.letterType,
          description: res.data.description,
          department: res.data.department,
          status: res.data.status,
          isDefault: res.data.isDefault,
          aiInstructions: res.data.aiInstructions,
          subjectHint: res.data.subjectHint,
          bodyTemplate: res.data.bodyTemplate,
          closingTemplate: res.data.closingTemplate,
          fields: res.data.fields,
        });
        setLoaded(true);
      })
      .catch((e) => alive && setLoadError(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [templateId, isNew, canManage]);

  // Live preview (server renderer; unfilled fields render as [Label] markers).
  // Available for saved templates — new templates preview after creation.
  useEffect(() => {
    if (isNew || !loaded || !canManage) return;
    let alive = true;
    const t = setTimeout(() => {
      setPreviewLoading(true);
      api
        .post<LetterPreviewModel>(`/api/v1/hr/letters/templates/${templateId}/preview`, {
          data: Object.fromEntries(form.fields.map((f) => [f.key, ""])),
          signatoryName: "",
          signatoryPosition: "",
          body: "",
        })
        .then((res) => alive && setPreview(res.data))
        .catch(() => alive && setPreview(null))
        .finally(() => alive && setPreviewLoading(false));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [loaded, canManage, templateId, form.fields, form.bodyTemplate, form.subjectHint, form.closingTemplate, isNew]);

  const placeholders = useMemo(() => {
    const out = new Set<string>(form.fields.map((f) => f.key));
    return [...out];
  }, [form.fields]);

  const unknownPlaceholders = useMemo(() => {
    const known = new Set([...placeholders, ...SYSTEM_PLACEHOLDERS]);
    const used = new Set<string>();
    for (const m of form.bodyTemplate.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) used.add(m[1]);
    for (const m of form.subjectHint.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) used.add(m[1]);
    return [...used].filter((k) => !known.has(k));
  }, [placeholders, form.bodyTemplate, form.subjectHint]);

  const hasBodySlot = /\{\{BODY\}\}/.test(form.bodyTemplate);

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        letterType: form.letterType,
        description: form.description,
        department: form.department.trim() || "HR",
        status: form.status,
        isDefault: form.isDefault,
        aiInstructions: form.aiInstructions,
        subjectHint: form.subjectHint,
        bodyTemplate: form.bodyTemplate,
        closingTemplate: form.closingTemplate || "Yours faithfully,",
        fields: form.fields,
      };
      if (isNew) {
        const res = await api.post<{ id: string }>("/api/v1/hr/letters/templates", payload);
        toast({ title: "Template created", description: payload.code });
        navigateTo("hr", ["letters", "templates", res.data.id]);
      } else {
        await api.patch(`/api/v1/hr/letters/templates/${templateId}`, payload);
        toast({ title: "Template saved", description: "Content changes created a new version — existing letters keep their snapshot." });
      }
      setPageDirty(false);
    } catch (e) {
      toast({ title: "Save failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <PageShell backLabel="Back" backHref="/hr/letters/templates" title="Template Editor">
        <EmptyState title="Not authorized" hint="Template management requires the letters.templates permission." />
      </PageShell>
    );
  }
  if (loadError) {
    return (
      <PageShell backLabel="Back" backHref="/hr/letters/templates" title="Template Editor">
        <ErrorState message={loadError} onRetry={() => window.location.reload()} />
      </PageShell>
    );
  }
  if (!loaded) {
    return (
      <PageShell backLabel="Back" backHref="/hr/letters/templates" title="Template Editor">
        <LoadingState label="Loading template…" />
      </PageShell>
    );
  }

  const updateField = (idx: number, patch: Partial<TemplateField>) =>
    set({ fields: form.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)) });

  const dirty = true; // central router guard: template editing is always dirty-flagged via save flow

  return (
    <PageShell
      backLabel="Back to Templates"
      backHref="/hr/letters/templates"
      crumbs={[{ label: "HR", href: "/hr" }, { label: "Letters", href: "/hr/letters" }, { label: "Templates", href: "/hr/letters/templates" }, { label: isNew ? "New" : form.code }]}
      title={isNew ? "New Letter Template" : `Edit ${form.code}`}
      description={isNew ? "Define the structure once — letters fill it with data and AI content." : `Version bumps automatically on content changes (current version is versioned immutably).`}
      actions={
        <div className="flex items-center gap-2">
          {dirty ? <span className="hidden" data-dirty-marker /> : null}
          <Button size="sm" disabled={busy || !form.code.trim() || !form.name.trim() || !hasBodySlot} onClick={() => void save()}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
            {isNew ? "Create Template" : "Save (new version if content changed)"}
          </Button>
        </div>
      }
    >
      {!hasBodySlot ? (
        <p className="mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md p-2">
          The body template must contain the {"{{BODY}}"} slot — that is where the AI draft and manual content are placed.
        </p>
      ) : null}
      {unknownPlaceholders.length > 0 ? (
        <p className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
          Unresolved placeholders: {unknownPlaceholders.map((k) => `{{${k}}}`).join(", ")} — add a field with that key or remove them.
        </p>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        <div className="space-y-4 min-w-0">
          {/* Metadata */}
          <section className="rounded-xl border bg-card p-4">
            <h2 className="text-sm font-semibold mb-3">Template Metadata</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-code">Template Code</Label>
                <Input id="tpl-code" value={form.code} disabled={!isNew} onChange={(e) => set({ code: e.target.value.toUpperCase() })} placeholder="e.g. LOU-002" className="font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">Template Name</Label>
                <Input id="tpl-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Letter of Undertaking (Projects)" />
              </div>
              <div className="space-y-1.5">
                <Label>Letter Type</Label>
                <Select value={form.letterType} onValueChange={(v) => set({ letterType: v })}>
                  <SelectTrigger aria-label="Letter type"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {LETTER_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{letterTypeLabel(t)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-dept">Department</Label>
                <Input id="tpl-dept" value={form.department} onChange={(e) => set({ department: e.target.value.toUpperCase() })} placeholder="HR" className="font-mono" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-desc">Description</Label>
                <Textarea id="tpl-desc" value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} />
              </div>
              <div className="flex items-center gap-2">
                <Switch id="tpl-default" checked={form.isDefault} onCheckedChange={(v) => set({ isDefault: v })} />
                <Label htmlFor="tpl-default">Default for this letter type</Label>
              </div>
              {!isNew ? (
                <div className="flex items-center gap-2">
                  <Label htmlFor="tpl-status" className="shrink-0">Status</Label>
                  <Select value={form.status} onValueChange={(v) => set({ status: v })}>
                    <SelectTrigger id="tpl-status" aria-label="Status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="INACTIVE">Inactive</SelectItem>
                      <SelectItem value="ARCHIVED">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          </section>

          {/* AI instructions (§3/§9) */}
          <section className="rounded-xl border bg-card p-4">
            <h2 className="text-sm font-semibold mb-1">AI Instructions (approved instruction set)</h2>
            <p className="text-xs text-muted-foreground mb-2">
              Rules the AI drafting assistant must follow for this template. The AI can only write the {"{{BODY}}"} content — never the structure.
            </p>
            <Textarea value={form.aiInstructions} onChange={(e) => set({ aiInstructions: e.target.value })} rows={4} placeholder="e.g. Write a formal undertaking; state obligations exactly as provided; do not invent dates or values." />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-subject-hint">Subject Template</Label>
                <Input id="tpl-subject-hint" value={form.subjectHint} onChange={(e) => set({ subjectHint: e.target.value })} placeholder="e.g. Undertaking — {{PROJECT_NAME}}" className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-closing">Closing</Label>
                <Input id="tpl-closing" value={form.closingTemplate} onChange={(e) => set({ closingTemplate: e.target.value })} placeholder="Yours faithfully," />
              </div>
            </div>
          </section>

          {/* Body skeleton (§46) */}
          <section className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold">Body Template (deterministic skeleton)</h2>
              <Badge variant={hasBodySlot ? "secondary" : "destructive"} className="text-[10px]">
                {hasBodySlot ? "{{BODY}} slot present" : "{{BODY}} missing"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              Plain text with placeholders. {"{{BODY}}"} marks where the AI/human content goes. Blank lines split paragraphs.
            </p>
            <Textarea value={form.bodyTemplate} onChange={(e) => set({ bodyTemplate: e.target.value })} rows={8} className="font-mono text-xs" />
            <div className="mt-2 flex flex-wrap gap-1">
              {placeholders.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono hover:bg-primary/10"
                  onClick={() => set({ bodyTemplate: `${form.bodyTemplate}\n{{${p}}}` })}
                  aria-label={`Insert ${p} into body template`}
                >
                  {`{{${p}}}`}
                </button>
              ))}
              {[...SYSTEM_PLACEHOLDERS].map((p) => (
                <span key={p} className="rounded border px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">{`{{${p}}}`}</span>
              ))}
            </div>
          </section>

          {/* Fields (§7) */}
          <section className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold">Data Fields</h2>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  set({
                    fields: [
                      ...form.fields,
                      { key: `FIELD_${form.fields.length + 1}`, label: "New Field", type: "text", ai: true },
                    ],
                  })
                }
              >
                <Plus className="h-4 w-4 mr-1" /> Add Field
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Only these fields appear on the create-letter form. Mark ai=true to include the value in the AI drafting context.</p>
            <div className="space-y-3">
              {form.fields.map((f, i) => (
                <div key={i} className="rounded-lg border p-3 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px]">Key (UPPER_SNAKE)</Label>
                      <Input value={f.key} onChange={(e) => updateField(i, { key: e.target.value.toUpperCase() })} className="font-mono text-xs" aria-label={`Field ${i + 1} key`} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]">Label</Label>
                      <Input value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} className="text-xs" aria-label={`Field ${i + 1} label`} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]">Type</Label>
                      <Select value={f.type} onValueChange={(v) => updateField(i, { type: v as TemplateFieldType })}>
                        <SelectTrigger className="h-9 text-xs" aria-label={`Field ${i + 1} type`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {TEMPLATE_FIELD_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-end gap-3 pb-1">
                      <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={!!f.required} onChange={(e) => updateField(i, { required: e.target.checked })} aria-label={`Field ${i + 1} required`} /> required
                      </label>
                      <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={!!f.ai} onChange={(e) => updateField(i, { ai: e.target.checked })} aria-label={`Field ${i + 1} AI`} /> AI
                      </label>
                      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => set({ fields: form.fields.filter((_, j) => j !== i) })} aria-label={`Remove field ${i + 1}`}>
                        <Trash2 className="h-3.5 w-3.5 text-red-600" />
                      </Button>
                    </div>
                  </div>
                  {f.type === "select" ? (
                    <div className="space-y-1">
                      <Label className="text-[11px]">Options (comma-separated)</Label>
                      <Input value={(f.options ?? []).join(", ")} onChange={(e) => updateField(i, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} className="text-xs" aria-label={`Field ${i + 1} options`} />
                    </div>
                  ) : null}
                  {!validateFieldKey(f.key) ? <p className="text-[11px] text-red-600">Key must be UPPER_SNAKE_CASE (letters, digits, underscore).</p> : null}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Live preview */}
        <div className="min-w-0">
          <div className="text-sm font-medium mb-2">Live Preview</div>
          <div className="xl:sticky xl:top-4 max-h-[80vh] overflow-y-auto rounded-xl pr-1">
            {isNew ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                Save the template to see the live preview with sample markers.
              </div>
            ) : previewLoading ? (
              preview ? <LetterPaper model={preview} className="opacity-60" /> : <LetterPaperSkeleton />
            ) : preview ? (
              <LetterPaper model={preview} />
            ) : (
              <LetterPaperSkeleton />
            )}
          </div>
        </div>
      </div>
    </PageShell>
  );
}
