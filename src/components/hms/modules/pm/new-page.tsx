"use client";

// MOHD.HMS ENTERPRISE — dedicated "New PM Plan" page (pm/new view).
// Replaces the old create-plan dialog as the primary plan entry mechanism.
// Reuses the existing PM plans API, RBAC and draft architecture — no new APIs.

import { useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, PM_FREQUENCIES, humanize } from "@/lib/hms/constants";
import { fmtDateTime } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, CalendarClock, Loader2, Plus, Save } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type EquipmentRef = { id: string; assetTag: string; name: string };
type TechnicianRef = { id: string; employeeNo: string; user: { id: string; name: string } | null };
type Option = { id: string; label: string };

type PlanForm = {
  name: string;
  equipmentId: string;
  frequency: string;
  assignedTechnicianId: string;
  checklist: string;
  nextDueDate: string;
};

type PmPlanCreated = { id: string; code: string; name: string };

const EMPTY_PLAN_FORM: PlanForm = {
  name: "",
  equipmentId: "",
  frequency: "MONTHLY",
  assignedTechnicianId: "",
  checklist: "",
  nextDueDate: "",
};

// ── Page ──

export function PmNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.pm_manage);

  const draft = useDraft<PlanForm>({ formKey: "pm.plan.create", initial: EMPTY_PLAN_FORM });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reference data — equipment + technicians lists (load on mount, degrade gracefully)
  const [equipmentOptions, setEquipmentOptions] = useState<Option[] | null>(null);
  const [technicianOptions, setTechnicianOptions] = useState<Option[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get<EquipmentRef[]>(`/api/v1/equipment${qs({ pageSize: "200" })}`);
        if (alive) setEquipmentOptions((res.data ?? []).map((e) => ({ id: e.id, label: `${e.name} (${e.assetTag})` })));
      } catch {
        if (alive) setEquipmentOptions(null);
      }
    })();
    (async () => {
      try {
        const res = await api.get<TechnicianRef[]>(`/api/v1/technicians${qs({ pageSize: "200" })}`);
        if (alive) setTechnicianOptions((res.data ?? []).map((t) => ({
          id: t.id,
          label: t.user?.name ? `${t.user.name} (${t.employeeNo})` : t.employeeNo,
        })));
      } catch {
        if (alive) setTechnicianOptions(null);
      }
    })();
    return () => { alive = false; };
  }, []);

  // ── Dirty-state wiring (central router guard + data protection) ──
  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!draft.value.name.trim()) errs.name = "Plan name is required.";
    if (!draft.value.equipmentId) errs.equipmentId = "Select the equipment this plan maintains.";
    return errs;
  }

  async function createPlan() {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast({ title: "Check the highlighted fields", variant: "destructive" });
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      const labels = draft.value.checklist.split("\n").map((l) => l.trim()).filter(Boolean);
      const res = await api.post<PmPlanCreated>("/api/v1/pm/plans", {
        name: draft.value.name.trim(),
        equipmentId: draft.value.equipmentId,
        frequency: draft.value.frequency,
        assignedTechnicianId: draft.value.assignedTechnicianId || null,
        checklistTemplate: labels,
        nextDueDate: draft.value.nextDueDate || null,
      });
      toast({ title: "PM plan created", description: `${res.data.code} — ${res.data.name}.` });
      draft.reset(EMPTY_PLAN_FORM);
      setPageDirty(false);
      navigateTo("pm");
    } catch (e) {
      // CRITICAL: keep every user-entered value on failure — show the error and allow retry.
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

  const actions = (
    <Button onClick={createPlan} disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
      {saving ? "Creating…" : "Create Plan"}
    </Button>
  );

  return (
    <PageShell
      backLabel="Back to Preventive Maintenance"
      backHref="/pm"
      crumbs={[{ label: "Preventive Maintenance", href: "/pm" }, { label: "New Plan" }]}
      title="New PM Plan"
      description="Schedule recurring maintenance for an equipment. Your draft is auto-saved as you type."
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{actions}</div>}
    >
      {/* Recoverable draft banner */}
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

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Plan details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pm-plan-name">Plan Name *</Label>
            <Input
              id="pm-plan-name"
              value={draft.value.name}
              onChange={(e) => { draft.setValue({ name: e.target.value }); setErrors((p) => ({ ...p, name: "" })); }}
              placeholder="Monthly HVAC filter service"
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "pm-plan-name-err" : undefined}
            />
            {errors.name ? <p id="pm-plan-name-err" className="text-xs text-destructive">{errors.name}</p> : null}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Equipment *</Label>
              <Select
                value={draft.value.equipmentId || undefined}
                onValueChange={(v) => { draft.setValue({ equipmentId: v }); setErrors((p) => ({ ...p, equipmentId: "" })); }}
              >
                <SelectTrigger aria-label="Equipment">
                  <SelectValue placeholder={equipmentOptions === null ? "Equipment list unavailable" : "Select equipment"} />
                </SelectTrigger>
                <SelectContent>
                  {(equipmentOptions ?? []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.equipmentId ? (
                <p className="text-xs text-destructive">{errors.equipmentId}</p>
              ) : equipmentOptions === null ? (
                <p className="text-xs text-amber-600">Equipment list could not be loaded. Try refreshing the page.</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label>Frequency</Label>
              <Select value={draft.value.frequency} onValueChange={(v) => draft.setValue({ frequency: v })}>
                <SelectTrigger aria-label="Frequency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PM_FREQUENCIES.map((f) => (
                    <SelectItem key={f} value={f}>{humanize(f)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Assigned Technician</Label>
              <Select
                value={draft.value.assignedTechnicianId || "NONE"}
                onValueChange={(v) => draft.setValue({ assignedTechnicianId: v === "NONE" ? "" : v })}
                disabled={technicianOptions === null}
              >
                <SelectTrigger aria-label="Technician"><SelectValue placeholder={technicianOptions === null ? "Unavailable" : "Unassigned"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Unassigned</SelectItem>
                  {(technicianOptions ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {technicianOptions === null ? (
                <p className="text-xs text-muted-foreground">Technician list unavailable — the plan can be assigned later.</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pm-plan-due">Next Due Date</Label>
              <Input
                id="pm-plan-due"
                type="date"
                value={draft.value.nextDueDate}
                onChange={(e) => draft.setValue({ nextDueDate: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Defaults to one frequency cycle from today.</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pm-plan-checklist">Checklist Labels (one per line)</Label>
            <Textarea
              id="pm-plan-checklist"
              rows={5}
              value={draft.value.checklist}
              onChange={(e) => draft.setValue({ checklist: e.target.value })}
              placeholder={"Inspect air filter\nCheck refrigerant pressure\nTest thermostat"}
            />
            <p className="text-xs text-muted-foreground">
              Each line becomes a checklist item technicians must tick off when completing a task.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Autosave hint */}
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
          <Button variant="outline" className="flex-1" onClick={() => { draft.saveNow(); toast({ title: "Draft saved successfully", description: "You can safely leave this page and restore the draft later." }); }} disabled={saving}>
            <Save className="h-4 w-4 mr-1.5" /> Save Draft
          </Button>
          <Button className="flex-1" onClick={() => void createPlan()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CalendarClock className="h-4 w-4 mr-1.5" />}
            {saving ? "Creating…" : "Create Plan"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
