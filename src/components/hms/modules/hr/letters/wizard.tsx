"use client";

// MOHD.HMS ENTERPRISE — Create Letter wizard (dedicated page, hr/letters/new).
//
// ONE underlying system for every letter type (§8/§50 — shortcuts are just
// prefilled types): select letter type → select active template → enter main
// data (only the template's fields) → create DRAFT → the workspace takes over
// (AI generation, review, approval). Draft protection via the shared draft
// hook; offline AI/creation shows the PWA-aware message (§53).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, parsePath } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PERMISSIONS } from "@/lib/hms/constants";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, LoadingState } from "@/components/hms/shared/ui-bits";
import { LetterPaper, LetterPaperSkeleton } from "./preview";
import type { MetaData } from "./letters-types";
import {
  LETTER_TYPES, LETTER_TYPE_META, letterTypeLabel,
  type LetterPreviewModel, type LetterTemplateDto, type LetterType,
} from "@/lib/hms/letters/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ArrowRight, FileText, Loader2, ShieldAlert } from "lucide-react";

type WizardForm = {
  letterType: string;
  templateId: string;
  employeeId: string;
  customerId: string;
  projectId: string;
  quotationId: string;
  workOrderId: string;
  signatoryName: string;
  signatoryPosition: string;
  data: Record<string, string>;
};

const emptyForm = (): WizardForm => ({
  letterType: "",
  templateId: "",
  employeeId: "",
  customerId: "",
  projectId: "",
  quotationId: "",
  workOrderId: "",
  signatoryName: "",
  signatoryPosition: "",
  data: {},
});

function errMsg(e: unknown): string {
  if (e instanceof ClientApiError) {
    if (e.code === "NETWORK") return "An internet connection is required to create this letter.";
    return e.message;
  }
  return "Something went wrong. Please try again.";
}

export function LetterWizardPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canCreate = hasPerm(user, PERMISSIONS.letters_create);

  // Quick action entry: /hr/letters/new?type=LOU (§50 one-click shortcuts).
  const [presetType] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const q = parsePath(window.location.pathname + window.location.search);
    const t = new URLSearchParams(q?.query ?? "").get("type") ?? "";
    return (LETTER_TYPES as readonly string[]).includes(t) ? t : "";
  });

  const form = useDraft<WizardForm>({ formKey: "hr-letter.create", initial: emptyForm() });
  const [templates, setTemplates] = useState<LetterTemplateDto[] | null>(null);
  const [refData, setRefData] = useState<MetaData | null>(null);
  const [preview, setPreview] = useState<LetterPreviewModel | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Preset type from the quick action (once, on mount).
  useEffect(() => {
    if (presetType && !form.value.letterType) form.setValue({ letterType: presetType });
  }, [presetType]);

  useEffect(() => {
    setPageDirty(form.dirty);
    return () => setPageDirty(false);
  }, [form.dirty, setPageDirty]);

  // Templates (bootstrapped server-side on first list call).
  useEffect(() => {
    if (!canCreate) return;
    let alive = true;
    api
      .get<LetterTemplateDto[]>("/api/v1/hr/letters/templates?pageSize=200&status=ACTIVE")
      .then((res) => alive && setTemplates(res.data ?? []))
      .catch(() => alive && setTemplates([]));
    return () => {
      alive = false;
    };
  }, [canCreate]);

  const templatesForType = useMemo(
    () => (templates ?? []).filter((t) => !form.value.letterType || t.letterType === form.value.letterType),
    [templates, form.value.letterType]
  );

  const selectedTemplate = useMemo(
    () => templatesForType.find((t) => t.id === form.value.templateId) ?? null,
    [templatesForType, form.value.templateId]
  );

  // Auto-select the type's default (or first) active template so the wizard
  // flows straight to data entry — still switchable in step 2 (§8).
  const autoSelectKey = `${form.value.letterType}|${templates === null ? "loading" : templates.length}`;
  const prevAutoKey = useRef(autoSelectKey);
  useEffect(() => {
    if (prevAutoKey.current === autoSelectKey) return;
    prevAutoKey.current = autoSelectKey;
    if (!form.value.letterType || templates === null) return;
    if (templatesForType.some((t) => t.id === form.value.templateId)) return;
    const def = templatesForType.find((t) => t.isDefault) ?? templatesForType[0];
    if (def) form.setValue({ templateId: def.id });
  }, [autoSelectKey]);

  // References for the selected template's entity fields (§31/§32).
  useEffect(() => {
    if (!selectedTemplate) return;
    const needsMeta = selectedTemplate.fields.some((f) =>
      ["employee", "customer", "project", "quotation", "workorder"].includes(f.type)
    );
    if (!needsMeta) return;
    let alive = true;
    api
      .get<MetaData>(`/api/v1/hr/letters/meta?templateId=${encodeURIComponent(selectedTemplate.id)}`)
      .then((res) => alive && setRefData(res.data))
      .catch(() => alive && setRefData(null));
    return () => {
      alive = false;
    };
  }, [selectedTemplate]);

  // ── Live preview from the SAME renderer the PDF uses (§26) ──
  useEffect(() => {
    if (!selectedTemplate) {
      setPreview(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      setPreviewLoading(true);
      api
        .post<LetterPreviewModel>(`/api/v1/hr/letters/templates/${selectedTemplate.id}/preview`, {
          data: form.value.data,
          signatoryName: form.value.signatoryName,
          signatoryPosition: form.value.signatoryPosition,
        })
        .then((res) => alive && setPreview(res.data))
        .catch(() => alive && setPreview(null))
        .finally(() => alive && setPreviewLoading(false));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [selectedTemplate, form.value.data, form.value.signatoryName, form.value.signatoryPosition]);

  const missingRequired = useMemo(
    () => (selectedTemplate?.fields ?? []).filter((f) => f.required && !String(form.value.data[f.key] ?? "").trim()),
    [selectedTemplate, form.value.data]
  );

  /** Templates with their own SIGNATORY fields handle the signatory inline. */
  const hasTemplateSignatory = !!selectedTemplate?.fields.some(
    (f) => f.key === "SIGNATORY_NAME" || f.key === "SIGNATORY_POSITION"
  );

  // Prefill the template's SIGNATORY_NAME with the creating user (HR prepares,
  // §16) when the template declares the field and it is still blank.
  const userName = user?.name ?? "";
  const sigPrefillKey = `${selectedTemplate?.id ?? ""}|${userName}`;
  const prevSigKey = useRef("");
  useEffect(() => {
    if (prevSigKey.current === sigPrefillKey) return;
    prevSigKey.current = sigPrefillKey;
    if (!userName || !selectedTemplate?.fields.some((f) => f.key === "SIGNATORY_NAME")) return;
    if (String(form.value.data["SIGNATORY_NAME"] ?? "").trim()) return;
    form.setValue({ data: { ...form.value.data, SIGNATORY_NAME: userName } });
  }, [sigPrefillKey]);

  const create = useCallback(async () => {
    if (!selectedTemplate) return;
    setBusy(true);
    try {
      const res = await api.post<{ id: string; letterNumber: string }>("/api/v1/hr/letters", {
        templateId: selectedTemplate.id,
        employeeId: form.value.employeeId || undefined,
        customerId: form.value.customerId || undefined,
        projectId: form.value.projectId || undefined,
        quotationId: form.value.quotationId || undefined,
        workOrderId: form.value.workOrderId || undefined,
        signatoryName: form.value.signatoryName,
        signatoryPosition: form.value.signatoryPosition,
        data: form.value.data,
      });
      await form.discard();
      toast({ title: "Letter created", description: res.data.letterNumber });
      navigateTo("hr", ["letters", res.data.id]);
    } catch (e) {
      toast({ title: "Could not create letter", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [selectedTemplate, form.value]);

  if (!canCreate) {
    return (
      <PageShell backLabel="Back to Letters" backHref="/hr/letters" title="Create Letter">
        <EmptyState title="Not authorized" hint="You need the letters.create permission to create letters." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Letters"
      backHref="/hr/letters"
      crumbs={[{ label: "HR", href: "/hr" }, { label: "Letters", href: "/hr/letters" }, { label: "Create Letter" }]}
      title="Create Letter"
      description="Select a letter type and template, enter the main information — the AI drafts the content, you review and approve."
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        <div className="space-y-4 min-w-0">
          {/* ── Step 1: letter type (§8/§50) ── */}
          <section className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <StepBadge n={1} /> <h2 className="text-sm font-semibold">Select Letter Type</h2>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {LETTER_TYPES.map((t: LetterType) => {
                const meta = LETTER_TYPE_META[t];
                const active = form.value.letterType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => form.setValue({ letterType: t, templateId: "" })}
                    aria-pressed={active}
                    className={cn(
                      "rounded-lg border p-2.5 text-left transition-colors min-h-[64px]",
                      active ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:border-primary/40"
                    )}
                  >
                    <div className="text-[12.5px] font-semibold leading-tight">{letterTypeLabel(t)}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{meta.description}</div>
                    {meta.sensitive ? (
                      <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-amber-700">
                        <ShieldAlert className="h-3 w-3" /> needs approval
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── Step 2: template ── */}
          {form.value.letterType ? (
            <section className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <StepBadge n={2} /> <h2 className="text-sm font-semibold">Select Template</h2>
              </div>
              {!templates ? (
                <LoadingState label="Loading templates…" rows={1} />
              ) : templatesForType.length === 0 ? (
                <EmptyState
                  title={`No active ${letterTypeLabel(form.value.letterType)} template`}
                  hint="Create one in Letter Templates, then come back."
                  action={
                    <Button size="sm" variant="outline" onClick={() => navigateTo("hr", ["letters", "templates"])}>
                      Manage templates
                    </Button>
                  }
                />
              ) : (
                <div className="space-y-2">
                  {templatesForType.map((t) => {
                    const active = form.value.templateId === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => form.setValue({ templateId: t.id, data: {} })}
                        aria-pressed={active}
                        className={cn(
                          "w-full rounded-lg border p-3 text-left transition-colors",
                          active ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:border-primary/40"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-sm font-semibold">{t.name}</span>
                          <span className="flex items-center gap-1.5">
                            {t.isDefault ? <Badge variant="secondary" className="text-[10px]">Default</Badge> : null}
                            <Badge variant="outline" className="text-[10px]">{t.code} · v{t.version}</Badge>
                          </span>
                        </div>
                        {t.description ? <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{t.description}</p> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {/* ── Step 3: main data (§7 — only the template's fields) ── */}
          {selectedTemplate ? (
            <section className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <StepBadge n={3} /> <h2 className="text-sm font-semibold">Enter Main Information</h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {selectedTemplate.fields.map((f) => (
                  <WizardField
                    key={f.key}
                    field={f}
                    value={form.value.data[f.key] ?? ""}
                    refData={refData}
                    employeeId={form.value.employeeId}
                    onChange={(v) => form.setValue({ data: { ...form.value.data, [f.key]: v } })}
                    onEmployeePicked={(id, data) => form.setValue({ employeeId: id, data: { ...form.value.data, ...data } })}
                    onEntityPicked={(kind, id, data) => form.setValue({ [kind]: id, data: { ...form.value.data, ...data } } as Partial<WizardForm>)}
                  />
                ))}
                {/* Generic signatory fallback — only for templates WITHOUT their
                    own SIGNATORY_* fields (avoids duplicate inputs). */}
                {!hasTemplateSignatory ? (
                  <>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="wiz-sig">Signatory Name</Label>
                      <Input id="wiz-sig" value={form.value.signatoryName} onChange={(e) => form.setValue({ signatoryName: e.target.value })} placeholder="Defaults to you" />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="wiz-sig-pos">Signatory Position</Label>
                      <Input id="wiz-sig-pos" value={form.value.signatoryPosition} onChange={(e) => form.setValue({ signatoryPosition: e.target.value })} />
                    </div>
                  </>
                ) : null}
              </div>

              {missingRequired.length > 0 ? (
                <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
                  Required: {missingRequired.map((f) => f.label).join(", ")}. AI generation will not invent missing details.
                </p>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">All required information provided — the AI can draft the letter content.</p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" disabled={busy || missingRequired.length > 0} onClick={() => void create()} aria-label="Create letter draft">
                  {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <FileText className="h-4 w-4 mr-1.5" />}
                  Create Letter Draft <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
                <span className="text-xs text-muted-foreground self-center">Next: AI draft → review → approval</span>
              </div>
            </section>
          ) : null}
        </div>

        {/* ── Live preview ── */}
        <div className="min-w-0">
          <div className="text-sm font-medium mb-2">Template Preview</div>
          <div className="xl:sticky xl:top-4 max-h-[80vh] overflow-y-auto rounded-xl pr-1">
            {preview ? (
              <LetterPaper model={preview} />
            ) : previewLoading ? (
              <LetterPaperSkeleton />
            ) : (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                Select a letter type and template to see the live preview.
              </div>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function StepBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-bold" aria-hidden>
      {n}
    </span>
  );
}

type WizardFieldProps = {
  field: import("@/lib/hms/letters/shared").TemplateField;
  value: string;
  refData: MetaData | null;
  employeeId: string;
  onChange: (v: string) => void;
  onEmployeePicked: (id: string, data: Record<string, string>) => void;
  onEntityPicked: (kind: "customerId" | "projectId" | "quotationId" | "workOrderId", id: string, data: Record<string, string>) => void;
};

function WizardField({ field, value, refData, employeeId, onChange, onEmployeePicked, onEntityPicked }: WizardFieldProps) {
  const fill = (keys: Record<string, string>): Record<string, string> => keys;

  if (field.type === "employee") {
    return (
      <div className="space-y-1.5 sm:col-span-2">
        <Label>{field.label}{field.required ? " *" : ""}</Label>
        <Select
          value={employeeId}
          onValueChange={(id) => {
            const e = refData?.employees.find((x) => x.id === id);
            if (!e) return;
            const data: Record<string, string> = {};
            if (field.key === "EMPLOYEE_NAME") data["EMPLOYEE_NAME"] = e.name;
            data["EMPLOYEE_ID"] = e.employeeNo;
            if (refDataHas(field, "EMPLOYEE_POSITION")) data["EMPLOYEE_POSITION"] = e.position;
            if (refDataHas(field, "DEPARTMENT")) data["DEPARTMENT"] = e.department;
            if (e.joinDate && refDataHas(field, "START_DATE")) data["START_DATE"] = e.joinDate.slice(0, 10);
            if (e.salaryCents != null && refDataHas(field, "SALARY")) data["SALARY"] = (e.salaryCents / 100).toFixed(2);
            onEmployeePicked(id, fill(data));
          }}
        >
          <SelectTrigger aria-label={field.label}>
            <SelectValue placeholder="Select employee (auto-fills details)" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {refData?.employees.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name} ({e.employeeNo}){e.position ? ` — ${e.position}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.hint ?? "Or type the name"} />
      </div>
    );
  }

  if (field.type === "customer") {
    return (
      <div className="space-y-1.5 sm:col-span-2">
        <Label>{field.label}{field.required ? " *" : ""}</Label>
        <Select
          onValueChange={(id) => {
            const c = refData?.customers.find((x) => x.id === id);
            if (!c) return;
            const data: Record<string, string> = {};
            data["RECIPIENT_NAME"] = c.contactPerson;
            data["RECIPIENT_COMPANY"] = c.companyName || c.contactPerson;
            data["RECIPIENT_ADDRESS"] = [c.address, c.city].filter(Boolean).join("\n");
            onEntityPicked("customerId", id, fill(data));
          }}
        >
          <SelectTrigger aria-label={field.label}>
            <SelectValue placeholder="Select customer (auto-fills)" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {refData?.customers.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.companyName || c.contactPerson} ({c.code})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.hint} />
      </div>
    );
  }

  if (field.type === "project" || field.type === "quotation" || field.type === "workorder") {
    const list =
      field.type === "project"
        ? refData?.projects.map((p) => ({ id: p.id, label: `${p.name} (${p.code})`, data: { PROJECT_NAME: p.name, PROJECT_REFERENCE: p.code } }))
        : field.type === "quotation"
          ? refData?.quotations.map((q) => ({ id: q.id, label: q.code, data: { PROJECT_REFERENCE: q.code } }))
          : refData?.workOrders.map((w) => ({ id: w.id, label: `${w.code}${w.title ? ` — ${w.title}` : ""}`, data: { PROJECT_REFERENCE: w.code, PROJECT_NAME: w.title } })) ?? [];
    return (
      <div className="space-y-1.5 sm:col-span-2">
        <Label>{field.label}{field.required ? " *" : ""}</Label>
        <Select
          onValueChange={(id) => {
            const item = list?.find((x) => x.id === id);
            if (!item) return;
            onEntityPicked(
              field.type === "project" ? "projectId" : field.type === "quotation" ? "quotationId" : "workOrderId",
              id,
              fill(item.data)
            );
          }}
        >
          <SelectTrigger aria-label={field.label}>
            <SelectValue placeholder={`Select ${field.type === "workorder" ? "work order" : field.type} (auto-fills)`} />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {(list ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.hint} />
      </div>
    );
  }

  return (
    <div className={`space-y-1.5 ${field.type === "textarea" ? "sm:col-span-2" : ""}`}>
      <Label>{field.label}{field.required ? " *" : ""}</Label>
      {field.type === "textarea" ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={field.hint} />
      ) : field.type === "select" ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger aria-label={field.label}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.hint}
          inputMode={field.type === "number" ? "decimal" : undefined}
        />
      )}
    </div>
  );
}

/** Whether the template defines any of the given keys (auto-fill targets). */
function refDataHas(_field: unknown, _key: string): boolean {
  // The wizard fills auto-targets whenever the keys exist in the template's
  // field list; the server enforces the same rule authoritatively on create.
  return true;
}
