"use client";

// MOHD.HMS ENTERPRISE — PM Plan detail page (pm/plans/{id} view).
// Tabs: Overview · Schedule (occurrence history) · Checklist · Parts ·
// Instructions · Findings · Costs (hidden for CUSTOMER role) · History ·
// Documents. pm_manage actions: quick-edit dialog, generate occurrence,
// activate/deactivate. Realtime refresh on PM events.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { navigateTo } from "@/lib/hms/router";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { customerLabel, fmtDate, fmtDateTime, money, toDateInput } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import {
  EmptyState, ErrorState, LoadingState, Money, PriorityBadge, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { BadgeCheck, Ban, CalendarClock, FileText, Loader2, Pencil, ShieldAlert, Wrench, Zap } from "lucide-react";
import {
  frequencyDescription, LabelValue, PRIORITY_OPTIONS, FREQUENCY_OPTIONS, type ChecklistItemDef, type RequiredPart,
} from "./pm-shared";

type PlanDetail = {
  id: string; code: string; name: string; description: string;
  planType: string; frequency: string; priority: string | null;
  customIntervalDays: number | null; intervalUnits: number | null; intervalUnit: string | null;
  monthlyOccurrence: string | null; monthlyWeekday: number | null;
  active: boolean; nextDueDate: string | null; lastCompletedAt: string | null;
  nextDueMeter: number | null; meterInterval: number | null;
  startDate: string | null; endDate: string | null;
  estimatedMinutes: number | null; requiredSkills: string; safetyRequirements: string; instructions: string;
  slaResponseHours: number | null; slaCompletionHours: number | null;
  checklistItems: ChecklistItemDef[]; requiredParts: RequiredPart[];
  equipment: {
    id: string; name: string; assetTag: string; criticality: string | null; category: string | null;
    model: string; manufacturer: string; warrantyExpiry: string | null; status: string;
    customer: { id: string; companyName: string; code: string } | null;
    location: { id: string; name: string } | null;
  } | null;
  assignedTechnician: { id: string; employeeNo: string; specialty: string | null; user: { id: string; name: string } | null } | null;
  meter: { id: string; name: string; unit: string; currentReading: number; currentReadingAt: string | null } | null;
  template: { id: string; name: string } | null;
  tasks: {
    id: string; code: string; dueDate: string; status: string; priority: string | null;
    completedAt: string | null; occurrenceKey: string; failureReason: string | null; rescheduleReason: string | null;
    technician: { user: { name: string } | null } | null;
    workOrder: { id: string; code: string; status: string; totalCents: number; labourTotalCents: number; materialsTotalCents: number } | null;
  }[];
  findings: {
    id: string; title: string; severity: string; description: string; recommendation: string;
    followUpRequired: boolean; createdAt: string;
    equipment: { id: string; name: string; assetTag: string } | null;
    correctiveWorkOrder: { id: string; code: string; status: string } | null;
    pmTask: { id: string; code: string } | null;
  }[];
  auditLogs: { id: string; action: string; createdAt: string; actorEmail: string | null; metadata: string | null }[];
  documents: { id: string; name: string; mimeType: string; sizeBytes: number; label: string | null; createdAt: string }[];
  costs: { labourCents: number; materialsCents: number; totalCents: number };
};

export function PmPlanDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.pm_manage);
  const isCustomer = user?.role === "CUSTOMER";

  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<PlanDetail>(`/api/v1/pm/plans/${encodeURIComponent(id)}`);
      setPlan(res.data);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this PM plan.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.pm, () => { void load(); });

  const generate = async () => {
    setGenerating(true);
    try {
      const res = await api.post<
        | { duplicate: false; task: { id: string; code: string } }
        | { duplicate: true; taskId: string | null; taskCode: string | null }
      >(`/api/v1/pm/plans/${encodeURIComponent(id)}/generate`);
      if (res.data.duplicate) {
        toast({ title: "Occurrence already open", description: res.data.taskCode ? `${res.data.taskCode} is the current open occurrence.` : "An open occurrence already exists." });
        if (res.data.taskId) navigateTo("pm", ["tasks", res.data.taskId]);
      } else {
        toast({ title: "Occurrence generated", description: `${res.data.task.code} scheduled with its execution work order.` });
        navigateTo("pm", ["tasks", res.data.task.id]);
      }
      await load();
    } catch (e) {
      toast({ title: "Generation failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const setActive = async (active: boolean) => {
    try {
      await api.patch(`/api/v1/pm/plans/${encodeURIComponent(id)}`, { active });
      toast({ title: active ? "Plan activated" : "Plan deactivated", description: `${plan?.code ?? ""} ${active ? "will generate new occurrences again." : "stopped generating new occurrences."}` });
      await load();
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  if (loading && !plan) {
    return (
      <PageShell backLabel="Back to PM Plans" backHref="/pm?tab=plans" title="PM plan">
        <LoadingState label="Loading plan…" rows={4} />
      </PageShell>
    );
  }
  if (loadError && !plan) {
    return (
      <PageShell backLabel="Back to PM Plans" backHref="/pm?tab=plans" title="PM plan">
        <ErrorState message={loadError} onRetry={() => void load()} />
      </PageShell>
    );
  }
  if (!plan) {
    return (
      <PageShell backLabel="Back to PM Plans" backHref="/pm?tab=plans" title="PM plan">
        <EmptyState title="Plan not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const nextDuePast = plan.active && plan.nextDueDate && new Date(plan.nextDueDate) <= new Date();

  return (
    <PageShell
      backLabel="Back to PM Plans"
      backHref="/pm?tab=plans"
      crumbs={[{ label: "Preventive Maintenance", href: "/pm" }, { label: "Plans", href: "/pm?tab=plans" }, { label: plan.code }]}
      title={plan.name}
      description={`${plan.code} · ${frequencyDescription(plan)}${plan.template ? ` · from template “${plan.template.name}”` : ""}`}
      actions={
        <div className="flex flex-wrap items-center gap-2 no-print">
          <StatusBadge status={plan.planType} />
          <PriorityBadge priority={plan.priority} />
          <Badge variant="outline" className={`border-transparent whitespace-nowrap ${plan.active ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"}`}>
            {plan.active ? "Active" : "Inactive"}
          </Badge>
          {canManage ? (
            <>
              <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4 mr-1.5" /> Edit
              </Button>
              <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => void setActive(!plan.active)}>
                {plan.active ? <><Ban className="h-4 w-4 mr-1.5" /> Deactivate</> : <><BadgeCheck className="h-4 w-4 mr-1.5" /> Activate</>}
              </Button>
            </>
          ) : null}
          {canManage || hasPerm(user, PERMISSIONS.pm_execute) ? (
            <Button size="sm" className="min-h-[44px]" disabled={generating || !plan.active} onClick={() => void generate()} title={!plan.active ? "Activate the plan first" : undefined}>
              {generating ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Zap className="h-4 w-4 mr-1.5" />}
              {generating ? "Generating…" : "Generate occurrence"}
            </Button>
          ) : null}
        </div>
      }
    >
      <Tabs defaultValue="overview">
        <TabsList className="mb-4 h-auto flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="schedule">Schedule ({plan.tasks.length})</TabsTrigger>
          <TabsTrigger value="checklist">Checklist</TabsTrigger>
          <TabsTrigger value="parts">Parts</TabsTrigger>
          <TabsTrigger value="instructions" className="hidden sm:inline-flex">Instructions</TabsTrigger>
          <TabsTrigger value="findings">Findings ({plan.findings.length})</TabsTrigger>
          {!isCustomer ? <TabsTrigger value="costs" className="hidden sm:inline-flex">Costs</TabsTrigger> : null}
          <TabsTrigger value="history" className="hidden md:inline-flex">History</TabsTrigger>
          <TabsTrigger value="documents" className="hidden md:inline-flex">Documents</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="shadow-sm">
              <CardHeader className="pb-3"><CardTitle className="text-base">Programme</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <LabelValue label="Code" value={<span className="font-mono text-xs">{plan.code}</span>} />
                <LabelValue label="Type" value={humanize(plan.planType)} />
                <LabelValue label="Cadence" value={frequencyDescription(plan)} />
                {plan.customIntervalDays ? <LabelValue label="Custom interval" value={`${plan.customIntervalDays} days`} /> : null}
                {plan.monthlyOccurrence && plan.monthlyWeekday !== null ? (
                  <LabelValue label="Monthly rule" value={`${humanize(plan.monthlyOccurrence)} weekday ${plan.monthlyWeekday}`} />
                ) : null}
                <LabelValue label="Priority" value={<PriorityBadge priority={plan.priority} />} />
                <LabelValue label="Status" value={<Badge variant="outline" className={`border-transparent ${plan.active ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"}`}>{plan.active ? "Active" : "Inactive"}</Badge>} />
                <LabelValue label="Start" value={fmtDate(plan.startDate)} />
                <LabelValue label="End" value={fmtDate(plan.endDate)} />
                <LabelValue label="Occurrences" value={plan.tasks.length} />
                <LabelValue label="Technician" value={plan.assignedTechnician?.user?.name ?? "Unassigned"} />
                {plan.slaResponseHours ? <LabelValue label="SLA response" value={`${plan.slaResponseHours} h`} /> : null}
                {plan.slaCompletionHours ? <LabelValue label="SLA completion" value={`${plan.slaCompletionHours} h`} /> : null}
                {plan.description ? <LabelValue label="Description" value={<span className="whitespace-pre-wrap font-normal">{plan.description}</span>} className="col-span-2 sm:col-span-3" /> : null}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="shadow-sm">
                <CardHeader className="pb-3"><CardTitle className="text-base">Schedule state</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-4">
                  <LabelValue
                    label="Next due"
                    value={<span className={nextDuePast ? "text-red-600 font-semibold" : ""}>{fmtDate(plan.nextDueDate)}{nextDuePast ? " (past)" : ""}</span>}
                  />
                  <LabelValue label="Last completed" value={fmtDateTime(plan.lastCompletedAt)} />
                  {plan.meter ? (
                    <>
                      <LabelValue label="Linked meter" value={`${plan.meter.name} (${plan.meter.unit})`} />
                      <LabelValue label="Current reading" value={plan.meter.currentReading} />
                      <LabelValue label="Next due at reading" value={plan.nextDueMeter ?? "—"} />
                      <LabelValue label="Meter interval" value={plan.meterInterval ? `every ${plan.meterInterval} ${plan.meter.unit}` : "—"} />
                    </>
                  ) : null}
                </CardContent>
              </Card>

              <Card className="shadow-sm">
                <CardHeader className="pb-3"><CardTitle className="text-base">Equipment</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  {plan.equipment ? (
                    <>
                      <a href={`/equipment/${encodeURIComponent(plan.equipment.id)}`} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 min-h-[44px] hover:bg-accent/60 transition-colors">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{plan.equipment.name}</span>
                          <span className="block text-xs text-muted-foreground">{plan.equipment.assetTag} · {plan.equipment.category ? humanize(plan.equipment.category) : "—"}</span>
                        </span>
                        <PriorityBadge priority={plan.equipment.criticality} />
                      </a>
                      <div className="grid grid-cols-2 gap-4">
                        <LabelValue label="Customer" value={customerLabel(plan.equipment.customer)} />
                        <LabelValue label="Location" value={plan.equipment.location?.name ?? "—"} />
                        <LabelValue label="Model" value={[plan.equipment.manufacturer, plan.equipment.model].filter(Boolean).join(" ") || "—"} />
                        <LabelValue label="Warranty" value={fmtDate(plan.equipment.warrantyExpiry)} />
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">No equipment linked.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* Schedule / occurrence history */}
        <TabsContent value="schedule">
          {plan.tasks.length === 0 ? (
            <EmptyState title="No occurrences yet" hint="Generate the first occurrence to start the schedule." />
          ) : (
            <Card className="shadow-sm">
              <CardContent className="p-0">
                <div className="divide-y max-h-96 overflow-y-auto hms-scroll">
                  {plan.tasks.map((t) => (
                    <button
                      key={t.id} type="button" onClick={() => navigateTo("pm", ["tasks", t.id])}
                      className="flex w-full flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-accent/50 transition-colors"
                    >
                      <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{t.code}</span>
                      <span className={`text-sm whitespace-nowrap ${["SCHEDULED", "OVERDUE", "IN_PROGRESS"].includes(t.status) && new Date(t.dueDate) < new Date() ? "text-red-600 font-medium" : ""}`}>
                        {fmtDate(t.dueDate)}
                      </span>
                      <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">
                        {t.occurrenceKey?.startsWith("meter:") ? `meter @ ${t.occurrenceKey.slice(6)}` : fmtDate(t.dueDate)}
                        {t.failureReason ? ` · failed: ${t.failureReason}` : ""}
                        {t.rescheduleReason ? ` · rescheduled: ${t.rescheduleReason}` : ""}
                      </span>
                      {t.workOrder ? (
                        <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">{t.workOrder.code}</span>
                      ) : null}
                      {t.priority ? <PriorityBadge priority={t.priority} /> : null}
                      <StatusBadge status={t.status} />
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Checklist */}
        <TabsContent value="checklist">
          <Card className="shadow-sm">
            <CardHeader className="pb-3"><CardTitle className="text-base">Checklist template ({plan.checklistItems.length} items)</CardTitle></CardHeader>
            <CardContent>
              {plan.checklistItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">No checklist items — occurrences can be completed without checks.</p>
              ) : (
                <ol className="space-y-2">
                  {plan.checklistItems.map((c, i) => (
                    <li key={i} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{i + 1}</span>
                      <span className="flex-1 min-w-0 text-sm">{c.label}</span>
                      {c.required ? <Badge variant="outline" className="border-transparent bg-red-100 text-red-700">Required</Badge> : null}
                      <Badge variant="outline" className="whitespace-nowrap">{c.responseType === "CHECKBOX" ? "Tick box" : humanize(c.responseType)}</Badge>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Parts */}
        <TabsContent value="parts">
          <Card className="shadow-sm">
            <CardHeader className="pb-3"><CardTitle className="text-base">Required parts ({plan.requiredParts.length})</CardTitle></CardHeader>
            <CardContent>
              {plan.requiredParts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No parts specified for this programme.</p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {plan.requiredParts.map((p, i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                      <span className="flex-1 min-w-0 truncate font-medium">{p.name}</span>
                      <span className="text-muted-foreground whitespace-nowrap">{p.quantity} {p.unit}</span>
                      {p.inventoryItemId ? <Badge variant="outline" className="whitespace-nowrap">Stock-linked</Badge> : null}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Instructions */}
        <TabsContent value="instructions">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="shadow-sm border-amber-500/40">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-amber-600" /> Safety requirements</CardTitle>
              </CardHeader>
              <CardContent>
                {plan.safetyRequirements ? (
                  <p className="text-sm whitespace-pre-wrap rounded-lg bg-amber-500/10 p-3 text-amber-900 dark:text-amber-200">{plan.safetyRequirements}</p>
                ) : <p className="text-sm text-muted-foreground">No special safety requirements recorded.</p>}
                {plan.requiredSkills ? (
                  <>
                    <Separator className="my-4" />
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Required skills</p>
                    <p className="text-sm whitespace-pre-wrap">{plan.requiredSkills}</p>
                  </>
                ) : null}
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4 text-primary" /> Instructions</CardTitle>
              </CardHeader>
              <CardContent>
                {plan.instructions ? (
                  <p className="text-sm whitespace-pre-wrap">{plan.instructions}</p>
                ) : <p className="text-sm text-muted-foreground">No step-by-step instructions recorded.</p>}
                <Separator className="my-4" />
                <p className="text-xs text-muted-foreground">Estimated duration: {plan.estimatedMinutes ?? 60} minutes per occurrence.</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Findings */}
        <TabsContent value="findings">
          {plan.findings.length === 0 ? (
            <EmptyState title="No findings" hint="Findings recorded during PM execution appear here." />
          ) : (
            <div className="space-y-3 max-h-[32rem] overflow-y-auto hms-scroll pr-1">
              {plan.findings.map((f) => (
                <Card key={f.id} className="shadow-sm">
                  <CardContent className="p-4 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <PriorityBadge priority={f.severity} />
                      <p className="font-medium text-sm flex-1 min-w-0 truncate">{f.title}</p>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(f.createdAt)}</span>
                    </div>
                    {f.description ? <p className="text-sm whitespace-pre-wrap">{f.description}</p> : null}
                    {f.recommendation ? <p className="text-xs text-muted-foreground"><span className="font-medium">Recommendation:</span> {f.recommendation}</p> : null}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {f.pmTask ? (
                        <button type="button" onClick={() => navigateTo("pm", ["tasks", f.pmTask!.id])} className="font-mono text-primary hover:underline">
                          {f.pmTask.code}
                        </button>
                      ) : null}
                      {f.correctiveWorkOrder ? (
                        <span className="inline-flex items-center gap-1">
                          corrective: <button type="button" onClick={() => navigateTo("work-orders", [f.correctiveWorkOrder!.id])} className="font-mono text-primary hover:underline">{f.correctiveWorkOrder.code}</button>
                          <StatusBadge status={f.correctiveWorkOrder.status} />
                        </span>
                      ) : f.followUpRequired && canManage ? (
                        <CreateCorrectiveButton findingId={f.id} onCreated={() => void load()} />
                      ) : null}
                      {f.followUpRequired && !f.correctiveWorkOrder ? <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800">Follow-up required</Badge> : null}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Costs (never for CUSTOMER role) */}
        {!isCustomer ? (
          <TabsContent value="costs">
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="shadow-sm">
                <CardHeader className="pb-3"><CardTitle className="text-base">Programme totals</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex items-center justify-between"><span className="text-muted-foreground">Labour</span><Money cents={plan.costs.labourCents} className="font-medium tabular-nums" /></div>
                  <div className="flex items-center justify-between"><span className="text-muted-foreground">Materials</span><Money cents={plan.costs.materialsCents} className="font-medium tabular-nums" /></div>
                  <Separator className="my-2" />
                  <div className="flex items-center justify-between"><span className="font-medium">Total</span><Money cents={plan.costs.totalCents} className="font-semibold tabular-nums" /></div>
                  <p className="text-xs text-muted-foreground pt-1">{plan.tasks.filter((t) => t.workOrder).length} execution work orders — costs are finalised when each occurrence completes.</p>
                </CardContent>
              </Card>
              <Card className="shadow-sm lg:col-span-2">
                <CardHeader className="pb-3"><CardTitle className="text-base">Per-occurrence costs</CardTitle></CardHeader>
                <CardContent className="p-0">
                  {plan.tasks.filter((t) => t.workOrder).length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">No billed occurrences yet.</p>
                  ) : (
                    <div className="divide-y max-h-80 overflow-y-auto hms-scroll">
                      {plan.tasks.filter((t) => t.workOrder).map((t) => (
                        <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                          <span className="font-mono text-xs text-muted-foreground w-20 shrink-0">{t.code}</span>
                          <button type="button" onClick={() => navigateTo("work-orders", [t.workOrder!.id])} className="font-mono text-xs text-primary hover:underline">{t.workOrder!.code}</button>
                          <span className="flex-1 min-w-0 text-xs text-muted-foreground">{fmtDate(t.dueDate)}</span>
                          <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">L {money(t.workOrder!.labourTotalCents)}</span>
                          <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">M {money(t.workOrder!.materialsTotalCents)}</span>
                          <Money cents={t.workOrder!.totalCents} className="font-medium tabular-nums whitespace-nowrap" />
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        ) : null}

        {/* History / audit */}
        <TabsContent value="history">
          {plan.auditLogs.length === 0 ? (
            <EmptyState title="No audit entries" />
          ) : (
            <Card className="shadow-sm">
              <CardContent className="p-0">
                <div className="divide-y max-h-96 overflow-y-auto hms-scroll">
                  {plan.auditLogs.map((a) => (
                    <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                      <span className="font-medium whitespace-nowrap">{humanize(a.action)}</span>
                      <span className="text-xs text-muted-foreground">{a.actorEmail ?? "system"}</span>
                      <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(a.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Documents */}
        <TabsContent value="documents">
          {plan.documents.length === 0 ? (
            <EmptyState title="No documents" hint="Files attached to this programme appear here." />
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto hms-scroll">
              {plan.documents.map((d) => (
                <div key={d.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 min-w-0 truncate">{d.name}</span>
                  {d.label ? <Badge variant="outline">{d.label}</Badge> : null}
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{Math.max(1, Math.round(d.sizeBytes / 1024))} KB</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:block">{fmtDate(d.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Quick edit dialog */}
      <QuickEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        plan={plan}
        saving={savingEdit}
        setSaving={setSavingEdit}
        onSaved={() => { setEditOpen(false); void load(); }}
      />
    </PageShell>
  );
}

function CreateCorrectiveButton({ findingId, onCreated }: { findingId: string; onCreated: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ id: string; code: string }>(`/api/v1/pm/findings/${encodeURIComponent(findingId)}/corrective-wo`);
      toast({ title: "Corrective work order created", description: `${res.data.code} — dispatch it from the Work Orders module.` });
      onCreated();
    } catch (e) {
      toast({ title: "Could not create corrective work order", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" className="h-7 text-xs min-h-[44px] sm:min-h-0" onClick={() => void create()} disabled={busy}>
      {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Wrench className="h-3 w-3 mr-1" />}
      Create corrective work order
    </Button>
  );
}

function QuickEditDialog({ open, onOpenChange, plan, saving, setSaving, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; plan: PlanDetail; saving: boolean; setSaving: (b: boolean) => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const { user } = useSession();
  const [technicians, setTechnicians] = useState<{ id: string; label: string }[]>([]);
  const [name, setName] = useState(plan.name);
  const [priority, setPriority] = useState(plan.priority ?? "");
  const [technicianId, setTechnicianId] = useState(plan.assignedTechnician?.id ?? "");
  const [nextDue, setNextDue] = useState(toDateInput(plan.nextDueDate));
  const [frequency, setFrequency] = useState(plan.frequency);

  useEffect(() => {
    if (!open) return;
    setName(plan.name);
    setPriority(plan.priority ?? "");
    setTechnicianId(plan.assignedTechnician?.id ?? "");
    setNextDue(toDateInput(plan.nextDueDate));
    setFrequency(plan.frequency);
    let alive = true;
    api.get<{ id: string; employeeNo: string; user: { name: string } | null }[]>("/api/v1/technicians?pageSize=200")
      .then((res) => { if (alive) setTechnicians((res.data ?? []).map((t) => ({ id: t.id, label: t.user?.name ? `${t.user.name} (${t.employeeNo})` : t.employeeNo }))); })
      .catch(() => { if (alive) setTechnicians([]); });
    return () => { alive = false; };
  }, [open, plan]);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/v1/pm/plans/${encodeURIComponent(plan.id)}`, {
        name: name.trim(),
        priority: priority || undefined,
        assignedTechnicianId: technicianId || null,
        nextDueDate: nextDue || null,
        frequency,
      });
      toast({ title: "Plan updated", description: `${plan.code} saved.` });
      onSaved();
    } catch (e) {
      toast({ title: "Could not save changes", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Quick edit — {plan.code}</DialogTitle>
          <DialogDescription>Name, priority, technician, next due and cadence. Full field edits stay on the create-grade form.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pm-edit-name">Plan name</Label>
            <Input id="pm-edit-name" value={name} onChange={(e) => setName(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={priority || "AUTO"} onValueChange={(v) => setPriority(v === "AUTO" ? "" : v)}>
                <SelectTrigger className="min-h-[44px]" aria-label="Priority"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="AUTO">Auto (from criticality)</SelectItem>
                  {PRIORITY_OPTIONS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger className="min-h-[44px]" aria-label="Frequency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FREQUENCY_OPTIONS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Technician</Label>
              <Select value={technicianId || "NONE"} onValueChange={(v) => setTechnicianId(v === "NONE" ? "" : v)}>
                <SelectTrigger className="min-h-[44px]" aria-label="Technician"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Unassigned</SelectItem>
                  {technicians.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pm-edit-next">Next due</Label>
              <Input id="pm-edit-next" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} className="min-h-[44px]" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CalendarClock className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
