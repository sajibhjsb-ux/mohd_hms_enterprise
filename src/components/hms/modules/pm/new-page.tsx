"use client";

// MOHD.HMS ENTERPRISE — dedicated "New PM Plan" page (pm/new view).
// Full plan builder: type (calendar vs meter engine), 9 frequencies with
// every-N + advanced monthly recurrence, auto-derived priority, template
// prefill (?templateId=), rich checklist editor, required parts, instructions,
// SLA hours. Draft protection via useDraft (keyed "pm-plan-new").

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useModuleQuery } from "@/lib/hms/page-query";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { humanize, PERMISSIONS, PM_METER_PLAN_TYPES, PM_PLAN_TYPES } from "@/lib/hms/constants";
import { fmtDateTime } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { AlertCircle, CalendarClock, Loader2, Plus, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ChecklistEditor, INTERVAL_UNITS, MONTHLY_OCCURRENCES, PLAN_TYPE_HINTS, PRIORITY_OPTIONS,
  RequiredPartsEditor, WEEKDAY_OPTIONS, usePmReferenceData,
  type ChecklistItemDef, type RequiredPart,
} from "./pm-shared";

// ── Types ──

type PlanForm = {
  name: string;
  description: string;
  equipmentId: string;
  planType: string;
  frequency: string;
  customIntervalDays: string;
  intervalUnits: string;
  intervalUnit: string;
  monthlyOccurrence: string;
  monthlyWeekday: string;
  priority: string; // "" = auto (from equipment criticality)
  assignedTechnicianId: string;
  checklist: ChecklistItemDef[];
  startDate: string;
  endDate: string;
  estimatedMinutes: string;
  requiredSkills: string;
  safetyRequirements: string;
  instructions: string;
  requiredParts: RequiredPart[];
  meterId: string;
  meterInterval: string;
  slaResponseHours: string;
  slaCompletionHours: string;
  templateId: string;
  templateName: string;
};

type MeterRow = { id: string; name: string; unit: string; currentReading: number };

const EMPTY_PLAN_FORM: PlanForm = {
  name: "", description: "", equipmentId: "", planType: "CALENDAR", frequency: "MONTHLY",
  customIntervalDays: "", intervalUnits: "", intervalUnit: "", monthlyOccurrence: "", monthlyWeekday: "",
  priority: "", assignedTechnicianId: "", checklist: [], startDate: "", endDate: "",
  estimatedMinutes: "60", requiredSkills: "", safetyRequirements: "", instructions: "",
  requiredParts: [], meterId: "", meterInterval: "", slaResponseHours: "", slaCompletionHours: "",
  templateId: "", templateName: "",
};

export function PmNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.pm_manage);
  const dq = useModuleQuery("pm");
  const templateIdParam = dq.params.templateId;

  const draft = useDraft<PlanForm>({ formKey: "pm-plan-new", initial: EMPTY_PLAN_FORM });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { equipment, technicians } = usePmReferenceData(canManage);
  const [meters, setMeters] = useState<MeterRow[] | null>(null);

  const isMeterType = PM_METER_PLAN_TYPES.includes(draft.value.planType as (typeof PM_METER_PLAN_TYPES)[number]);
  const isCalendarOnlyNote = ["CONDITION", "SEASONAL", "INSPECTION"].includes(draft.value.planType);

  // Template prefill (?templateId= from the Templates tab "Use in plan").
  useEffect(() => {
    if (!templateIdParam || !canManage) return;
    if (draft.value.templateId === templateIdParam) return;
    let alive = true;
    api.get<{ id: string; name: string; itemsParsed?: ChecklistItemDef[]; items?: ChecklistItemDef[] }>(`/api/v1/pm/templates/${encodeURIComponent(templateIdParam)}`)
      .then((res) => {
        if (!alive) return;
        const t = res.data;
        const items = (t.itemsParsed ?? t.items ?? []).map((i) => ({ label: i.label, required: !!i.required, responseType: i.responseType || "CHECKBOX" }));
        draft.setValue({ templateId: t.id, templateName: t.name, checklist: items });
        toast({ title: "Template applied", description: `${items.length} checklist item${items.length === 1 ? "" : "s"} loaded from “${t.name}”.` });
      })
      .catch(() => {
        if (alive) toast({ title: "Template could not be loaded", description: "Start with an empty checklist instead.", variant: "destructive" });
      });
    return () => { alive = false; };
  }, [templateIdParam, canManage]);

  // Meters for the selected equipment (meter-driven plans link one).
  useEffect(() => {
    if (!draft.value.equipmentId || !isMeterType) { setMeters(null); return; }
    let alive = true;
    api.get<MeterRow[]>(`/api/v1/pm/meters?equipmentId=${encodeURIComponent(draft.value.equipmentId)}`)
      .then((res) => { if (alive) setMeters(res.data ?? []); })
      .catch(() => { if (alive) setMeters([]); });
    return () => { alive = false; };
  }, [draft.value.equipmentId, isMeterType]);

  // Dirty-state wiring (central router guard + draft persistence).
  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  const equipmentCriticality = useMemo(
    () => (equipment ?? []).find((e) => e.id === draft.value.equipmentId)?.criticality ?? null,
    [equipment, draft.value.equipmentId]
  );

  function validate(): Record<string, string> {
    const v = draft.value;
    const errs: Record<string, string> = {};
    if (!v.name.trim() || v.name.trim().length < 2) errs.name = "Plan name is required.";
    if (!v.equipmentId) errs.equipmentId = "Select the equipment this plan maintains.";
    if (isMeterType) {
      if (!v.meterId) errs.meterId = "Meter-based plans require a linked equipment meter.";
      if (!v.meterInterval || Number(v.meterInterval) <= 0) errs.meterInterval = "Enter a positive service interval.";
    } else {
      if (v.frequency === "CUSTOM" && (!v.customIntervalDays || Number(v.customIntervalDays) <= 0)) {
        errs.customIntervalDays = "Custom frequency needs a positive interval in days.";
      }
      if (v.monthlyOccurrence && v.monthlyWeekday === "") {
        errs.monthlyWeekday = "Pick the weekday for the monthly recurrence.";
      }
    }
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      errs.endDate = "End date must be on or after the start date.";
    }
    if (v.checklist.some((c) => !c.label.trim())) {
      errs.checklist = "Every checklist item needs a label.";
    }
    return errs;
  }

  async function createPlan() {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast({ title: "Check the highlighted fields", variant: "destructive" });
      return;
    }
    const v = draft.value;
    setSaving(true);
    setSubmitError(null);
    try {
      const payload: Record<string, unknown> = {
        name: v.name.trim(),
        description: v.description,
        equipmentId: v.equipmentId,
        planType: v.planType,
        frequency: v.frequency,
        priority: v.priority || undefined, // "" → server derives from equipment criticality
        assignedTechnicianId: v.assignedTechnicianId || null,
        checklistTemplate: v.checklist.filter((c) => c.label.trim()).map((c) => ({ label: c.label.trim(), required: c.required, responseType: c.responseType })),
        startDate: v.startDate || null,
        endDate: v.endDate || null,
        estimatedMinutes: v.estimatedMinutes ? Math.max(5, Math.min(1440, Number(v.estimatedMinutes))) : undefined,
        requiredSkills: v.requiredSkills,
        safetyRequirements: v.safetyRequirements,
        instructions: v.instructions,
        requiredParts: v.requiredParts
          .filter((p) => p.name.trim())
          .map((p) => ({ inventoryItemId: p.inventoryItemId || null, name: p.name.trim(), quantity: p.quantity > 0 ? p.quantity : 1, unit: p.unit || "pcs" })),
        slaResponseHours: v.slaResponseHours ? Number(v.slaResponseHours) : null,
        slaCompletionHours: v.slaCompletionHours ? Number(v.slaCompletionHours) : null,
        templateId: v.templateId || null,
      };
      if (isMeterType) {
        payload.meterId = v.meterId;
        payload.meterInterval = Number(v.meterInterval);
      } else {
        payload.customIntervalDays = v.frequency === "CUSTOM" && v.customIntervalDays ? Number(v.customIntervalDays) : null;
        payload.intervalUnits = v.intervalUnits ? Number(v.intervalUnits) : null;
        payload.intervalUnit = v.intervalUnits ? v.intervalUnit : null;
        payload.monthlyOccurrence = v.monthlyOccurrence || null;
        payload.monthlyWeekday = v.monthlyOccurrence && v.monthlyWeekday !== "" ? Number(v.monthlyWeekday) : null;
      }

      const res = await api.post<{ id: string; code: string; name: string }>("/api/v1/pm/plans", payload);
      toast({ title: "PM plan created", description: `${res.data.code} — ${res.data.name}.` });
      draft.reset(EMPTY_PLAN_FORM);
      setPageDirty(false);
      navigateTo("pm", ["plans", res.data.id]);
    } catch (e) {
      // Keep every user-entered value on failure — show the error and allow retry.
      const msg = e instanceof Error ? e.message : "Could not create the plan. Please try again.";
      setSubmitError(msg);
      toast({ title: "Could not create plan", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageShell backLabel="Back to Preventive Maintenance" backHref="/pm" title="New PM Plan">
        <EmptyState
          title="You don't have permission to create PM plans"
          hint="Plan creation is limited to supervisors, admins and super admins. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const err = (k: string) => errors[k] ? <p className="text-xs text-destructive mt-1">{errors[k]}</p> : null;

  const actions = (
    <Button onClick={() => void createPlan()} disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
      {saving ? "Creating…" : "Create Plan"}
    </Button>
  );

  return (
    <PageShell
      backLabel="Back to Preventive Maintenance"
      backHref="/pm?tab=plans"
      crumbs={[{ label: "Preventive Maintenance", href: "/pm" }, { label: "New Plan" }]}
      title="New PM Plan"
      description="Schedule recurring maintenance for an asset — calendar cadence or meter threshold. Your draft auto-saves as you type."
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{actions}</div>}
    >
      {draft.draftExists ? (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-sm">
          <span className="text-muted-foreground">
            Unsubmitted draft saved {draft.lastSavedAt ? fmtDateTime(draft.lastSavedAt) : "earlier"} — restore it to continue where you left off.
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={draft.restore}>Restore saved draft</Button>
            <Button size="sm" variant="ghost" onClick={draft.discard}>Discard</Button>
          </div>
        </div>
      ) : null}

      {submitError ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">The plan could not be created.</p>
            <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
          </div>
        </div>
      ) : null}

      {draft.value.templateName ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
          <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
          <span>Checklist prefilled from template <strong>{draft.value.templateName}</strong> — adjust freely below.</span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Core details */}
        <Card className="shadow-sm lg:col-span-2">
          <CardHeader className="pb-3"><CardTitle className="text-base">Plan details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="pm-plan-name" className="text-sm font-medium">Plan Name *</label>
              <Input
                id="pm-plan-name" value={draft.value.name} className="min-h-[44px]"
                onChange={(e) => { draft.setValue({ name: e.target.value }); setErrors((p) => ({ ...p, name: "" })); }}
                placeholder="Monthly HVAC filter service" aria-invalid={!!errors.name}
              />
              {err("name")}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="pm-plan-desc" className="text-sm font-medium">Description</label>
              <Textarea id="pm-plan-desc" rows={2} className="min-h-[44px]" value={draft.value.description} onChange={(e) => draft.setValue({ description: e.target.value })} placeholder="What this programme covers and why" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Equipment *</label>
                <Select
                  value={draft.value.equipmentId || undefined}
                  onValueChange={(v) => { draft.setValue({ equipmentId: v, meterId: "" }); setErrors((p) => ({ ...p, equipmentId: "" })); }}
                >
                  <SelectTrigger aria-label="Equipment" className="min-h-[44px]">
                    <SelectValue placeholder={equipment === null ? "Equipment list unavailable" : "Select equipment"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(equipment ?? []).map((e) => <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {err("equipmentId")}
                {equipmentCriticality ? (
                  <p className="text-xs text-muted-foreground">Asset criticality: <span className="font-medium">{humanize(equipmentCriticality)}</span> — plan priority defaults from it.</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Plan Type</label>
                <Select value={draft.value.planType} onValueChange={(v) => draft.setValue({ planType: v, meterId: "", meterInterval: "" })}>
                  <SelectTrigger aria-label="Plan type" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PM_PLAN_TYPES.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{PLAN_TYPE_HINTS[draft.value.planType]}</p>
              </div>
            </div>

            {/* Meter engine fields */}
            {isMeterType ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border bg-muted/20 p-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Equipment Meter *</label>
                  <Select value={draft.value.meterId || undefined} onValueChange={(v) => draft.setValue({ meterId: v })}>
                    <SelectTrigger aria-label="Meter" className="min-h-[44px]">
                      <SelectValue placeholder={meters === null ? "Select equipment first" : meters.length === 0 ? "No meters on this equipment" : "Select meter"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(meters ?? []).map((m) => <SelectItem key={m.id} value={m.id}>{m.name} ({m.unit}, now {m.currentReading})</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {err("meterId")}
                  {meters !== null && meters.length === 0 ? (
                    <p className="text-xs text-amber-600">This equipment has no meters yet. Create one from the equipment page or the PM meters API, then link it here.</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="pm-meter-interval" className="text-sm font-medium">Service Interval (meter units) *</label>
                  <Input id="pm-meter-interval" inputMode="decimal" className="min-h-[44px]" value={draft.value.meterInterval}
                    onChange={(e) => draft.setValue({ meterInterval: e.target.value.replace(/[^\d.]/g, "") })}
                    placeholder="e.g. 500 (run-hours / km / cycles)" aria-invalid={!!errors.meterInterval} />
                  {err("meterInterval")}
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Frequency</label>
                    <Select value={draft.value.frequency} onValueChange={(v) => draft.setValue({ frequency: v })}>
                      <SelectTrigger aria-label="Frequency" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "EVERY_2_MONTHS", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL", "CUSTOM"].map((f) => (
                          <SelectItem key={f} value={f}>{humanize(f)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {draft.value.frequency === "CUSTOM" ? (
                    <div className="space-y-1.5">
                      <label htmlFor="pm-custom-days" className="text-sm font-medium">Custom Interval (days) *</label>
                      <Input id="pm-custom-days" inputMode="numeric" className="min-h-[44px]" value={draft.value.customIntervalDays}
                        onChange={(e) => draft.setValue({ customIntervalDays: e.target.value.replace(/\D/g, "") })}
                        placeholder="e.g. 45" aria-invalid={!!errors.customIntervalDays} />
                      {err("customIntervalDays")}
                    </div>
                  ) : null}
                </div>
                <Accordion type="single" collapsible>
                  <AccordionItem value="advanced" className="border rounded-lg px-3">
                    <AccordionTrigger className="text-sm py-3">Advanced recurrence (optional)</AccordionTrigger>
                    <AccordionContent className="space-y-4 pb-3">
                      <p className="text-xs text-muted-foreground">Override the plain cadence — e.g. “Second Monday of every month”. Leave empty to use the frequency above.</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Occurrence in month</label>
                          <Select value={draft.value.monthlyOccurrence || "NONE"} onValueChange={(v) => draft.setValue({ monthlyOccurrence: v === "NONE" ? "" : v })}>
                            <SelectTrigger aria-label="Monthly occurrence" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="NONE">— Not used —</SelectItem>
                              {MONTHLY_OCCURRENCES.map((o) => <SelectItem key={o} value={o}>{humanize(o)}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Weekday</label>
                          <Select value={draft.value.monthlyWeekday === "" ? "NONE" : draft.value.monthlyWeekday} onValueChange={(v) => draft.setValue({ monthlyWeekday: v === "NONE" ? "" : v })}>
                            <SelectTrigger aria-label="Weekday" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="NONE">— Not used —</SelectItem>
                              {WEEKDAY_OPTIONS.map((w) => <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          {err("monthlyWeekday")}
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <label htmlFor="pm-every-n" className="text-sm font-medium">Every N cycles</label>
                          <Input id="pm-every-n" inputMode="numeric" className="min-h-[44px]" value={draft.value.intervalUnits}
                            onChange={(e) => draft.setValue({ intervalUnits: e.target.value.replace(/\D/g, "") })} placeholder="e.g. 3 (of the unit below)" />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-sm font-medium">Interval unit</label>
                          <Select value={draft.value.intervalUnit || "NONE"} onValueChange={(v) => draft.setValue({ intervalUnit: v === "NONE" ? "" : v })}>
                            <SelectTrigger aria-label="Interval unit" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="NONE">— Not used —</SelectItem>
                              {INTERVAL_UNITS.map((u) => <SelectItem key={u} value={u}>{humanize(u)}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Priority</label>
                <Select value={draft.value.priority || "AUTO"} onValueChange={(v) => draft.setValue({ priority: v === "AUTO" ? "" : v })}>
                  <SelectTrigger aria-label="Priority" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AUTO">Auto (from equipment criticality)</SelectItem>
                    {PRIORITY_OPTIONS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Assigned Technician</label>
                <Select
                  value={draft.value.assignedTechnicianId || "NONE"}
                  onValueChange={(v) => draft.setValue({ assignedTechnicianId: v === "NONE" ? "" : v })}
                  disabled={technicians === null}
                >
                  <SelectTrigger aria-label="Technician" className="min-h-[44px]"><SelectValue placeholder={technicians === null ? "Unavailable" : "Unassigned"} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">Unassigned</SelectItem>
                    {(technicians ?? []).map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {technicians === null ? <p className="text-xs text-muted-foreground">Technician list unavailable — the plan can be assigned later.</p> : null}
              </div>
              <div className="space-y-1.5">
                <label htmlFor="pm-start" className="text-sm font-medium">Start Date</label>
                <Input id="pm-start" type="date" className="min-h-[44px]" value={draft.value.startDate} onChange={(e) => draft.setValue({ startDate: e.target.value })} />
                <p className="text-xs text-muted-foreground">First occurrence is due on this date (defaults to today).</p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="pm-end" className="text-sm font-medium">End Date</label>
                <Input id="pm-end" type="date" className="min-h-[44px]" value={draft.value.endDate} onChange={(e) => draft.setValue({ endDate: e.target.value })} aria-invalid={!!errors.endDate} />
                {err("endDate")}
                <p className="text-xs text-muted-foreground">Scheduling stops after this date — useful for warranty-bound programmes.</p>
              </div>
            </div>

            {isCalendarOnlyNote ? (
              <p className="text-xs text-muted-foreground rounded-lg bg-muted/40 p-2.5">
                {humanize(draft.value.planType)} plans run on the <strong>calendar engine</strong> — pick the cadence and build a
                condition-oriented checklist; no meter link is needed.
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* Execution guidance + SLA */}
        <div className="space-y-4">
          <Card className="shadow-sm">
            <CardHeader className="pb-3"><CardTitle className="text-base">Execution guidance</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="pm-minutes" className="text-sm font-medium">Estimated Duration (minutes)</label>
                <Input id="pm-minutes" inputMode="numeric" className="min-h-[44px]" value={draft.value.estimatedMinutes}
                  onChange={(e) => draft.setValue({ estimatedMinutes: e.target.value.replace(/\D/g, "") })} placeholder="60" />
                <p className="text-xs text-muted-foreground">Shown to the technician; drives planning (5–1440).</p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="pm-skills" className="text-sm font-medium">Required Skills</label>
                <Textarea id="pm-skills" rows={2} className="min-h-[44px]" value={draft.value.requiredSkills} onChange={(e) => draft.setValue({ requiredSkills: e.target.value })} placeholder="e.g. HVAC licence, refrigerant handling" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="pm-safety" className="text-sm font-medium">Safety Requirements</label>
                <Textarea id="pm-safety" rows={2} className="min-h-[44px]" value={draft.value.safetyRequirements} onChange={(e) => draft.setValue({ safetyRequirements: e.target.value })} placeholder="e.g. LOTO before opening the panel" />
                <p className="text-xs text-muted-foreground">Highlighted on the task execution page.</p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="pm-instructions" className="text-sm font-medium">Instructions</label>
                <Textarea id="pm-instructions" rows={4} className="min-h-[44px]" value={draft.value.instructions} onChange={(e) => draft.setValue({ instructions: e.target.value })} placeholder="Step-by-step guidance for the technician…" />
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-3"><CardTitle className="text-base">SLA (hours)</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label htmlFor="pm-sla-resp" className="text-sm font-medium">Response</label>
                <Input id="pm-sla-resp" inputMode="numeric" className="min-h-[44px]" value={draft.value.slaResponseHours}
                  onChange={(e) => draft.setValue({ slaResponseHours: e.target.value.replace(/\D/g, "") })} placeholder="e.g. 4" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="pm-sla-comp" className="text-sm font-medium">Completion</label>
                <Input id="pm-sla-comp" inputMode="numeric" className="min-h-[44px]" value={draft.value.slaCompletionHours}
                  onChange={(e) => draft.setValue({ slaCompletionHours: e.target.value.replace(/\D/g, "") })} placeholder="e.g. 48" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Checklist + parts (full width) */}
        <Card className="shadow-sm lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Checklist</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <TemplatePicker onApply={(t, items) => draft.setValue({ templateId: t.id, templateName: t.name, checklist: items })} />
            {errors.checklist ? <p className="text-xs text-destructive">{errors.checklist}</p> : null}
            <ChecklistEditor items={draft.value.checklist} onChange={(items) => draft.setValue({ checklist: items })} />
          </CardContent>
        </Card>

        <Card className="shadow-sm lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Required Parts</CardTitle>
          </CardHeader>
          <CardContent>
            <RequiredPartsEditor parts={draft.value.requiredParts} onChange={(parts) => draft.setValue({ requiredParts: parts })} />
          </CardContent>
        </Card>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {draft.dirty
          ? "Draft auto-saved — safe to leave this page and restore the draft later."
          : draft.lastSavedAt
            ? `Draft saved at ${fmtDateTime(draft.lastSavedAt)}.`
            : "Tip: your entries auto-save as a draft while you type."}
      </p>

      {/* Sticky mobile action bar */}
      <div className={cn("sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-2 lg:hidden no-print")}>
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          <Button variant="outline" className="flex-1 min-h-[44px]" onClick={() => { draft.saveNow(); toast({ title: "Draft saved successfully", description: "You can safely leave this page and restore the draft later." }); }} disabled={saving}>
            <Save className="h-4 w-4 mr-1.5" /> Save Draft
          </Button>
          <Button className="flex-1 min-h-[44px]" onClick={() => void createPlan()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CalendarClock className="h-4 w-4 mr-1.5" />}
            {saving ? "Creating…" : "Create Plan"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}

/** "Load from template…" — fetches active templates and applies the picked one. */
function TemplatePicker({ onApply }: { onApply: (t: { id: string; name: string }, items: ChecklistItemDef[]) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<{ id: string; name: string; category: string; itemCount: number }[]>([]);
  const [failed, setFailed] = useState(false);

  const loadTemplates = async () => {
    setLoading(true);
    setFailed(false);
    try {
      // API returns { templates, categories } — accept both shapes defensively.
      const res = await api.get<{ templates?: { id: string; name: string; category: string; itemsParsed?: unknown[]; items?: unknown[]; _count?: { tasks?: number; plans?: number; items?: number } }[] }>("/api/v1/pm/templates?active=1");
      const raw = Array.isArray(res.data) ? res.data : (res.data?.templates ?? []);
      setTemplates(raw.map((t) => ({
        id: t.id, name: t.name, category: t.category,
        itemCount: (t.itemsParsed ?? t.items ?? []).length || (t._count?.items ?? 0),
      })));
      setOpen(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const apply = async (id: string) => {
    setOpen(false);
    try {
      const res = await api.get<{ id: string; name: string; itemsParsed?: ChecklistItemDef[]; items?: ChecklistItemDef[] }>(`/api/v1/pm/templates/${encodeURIComponent(id)}`);
      const t = res.data;
      const items = (t.itemsParsed ?? t.items ?? []).map((i) => ({ label: i.label, required: !!i.required, responseType: i.responseType || "CHECKBOX" }));
      onApply({ id: t.id, name: t.name }, items);
    } catch {
      // silent — the picker simply doesn't prefill
    }
  };

  return (
    <div>
      <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={() => void loadTemplates()} disabled={loading}>
        <CalendarClock className="h-4 w-4 mr-1.5" /> {loading ? "Loading templates…" : "Load from template…"}
      </Button>
      {failed ? <p className="mt-1.5 text-xs text-amber-600">Template list is not available yet — build the checklist manually.</p> : null}
      {open ? (
        <div className="mt-2 rounded-lg border p-2 space-y-1 max-h-60 overflow-y-auto hms-scroll">
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground p-2">No active templates found.</p>
          ) : templates.map((t) => (
            <button
              key={t.id} type="button" onClick={() => void apply(t.id)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 min-h-[44px] text-left text-sm hover:bg-accent/60"
            >
              <span className="truncate font-medium">{t.name}</span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">{humanize(t.category)} · {t.itemCount} items</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
