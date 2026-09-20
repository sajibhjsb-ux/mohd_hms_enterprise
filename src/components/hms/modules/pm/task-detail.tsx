"use client";

// MOHD.HMS ENTERPRISE — PM Task detail + EXECUTION cockpit (pm/tasks/{id}).
// The technician's mobile-first workplace: equipment card, plan instructions,
// work-order lifecycle (accept/start/complete via the CANONICAL WO API §22),
// rich checklist recording (5 response types), photos by phase, findings,
// meter readings, materials, and the sticky action footer (Complete / Mark
// failed / Reschedule / Skip). Draft protection §29: checklist responses and
// notes persist to localStorage keyed "pm-exec-{taskId}" and restore on mount.
// CUSTOMER role sees schedule info, WO status, findings and photos only (§44).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { navigateTo } from "@/lib/hms/router";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS, humanize, PM_FINDING_SEVERITIES } from "@/lib/hms/constants";
import { customerLabel, fmtDate, fmtDateTime, toCents } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import {
  EmptyState, ErrorState, LoadingState, Money, PriorityBadge, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUi } from "@/lib/hms/ui-store";
import {
  AlertTriangle, CalendarClock as CalendarIcon, Camera, Check, CheckCircle2, CircleDashed, CircleOff, ClipboardCheck, Droplets, Flag,
  ImageIcon, Link2, Loader2, Package, PauseCircle, Play, Plus, ShieldAlert, Trash2, Wrench, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { daysOverdue, isTaskOpen, LabelValue } from "./pm-shared";

// ── Types ──

type WOChecklistItem = {
  id: string; label: string; done: boolean; required: boolean;
  responseType: string; response: string | null; notes: string | null; sortOrder: number;
};
type WOMaterial = {
  id: string; name: string; quantity: number; unitCostCents: number; totalCents: number;
  inventoryItemId: string | null; inventoryItem?: { id: string; name: string; unit: string } | null;
};
type PhotoDoc = { id: string; name: string; mimeType: string; sizeBytes: number; label: string | null; createdAt: string };
type FindingRow = {
  id: string; title: string; severity: string; description: string; cause?: string;
  recommendation: string; immediateAction?: string; followUpRequired: boolean; createdAt: string;
  correctiveWorkOrder?: { id: string; code: string; status: string } | null;
};
type TaskDetail = {
  id: string; code: string; dueDate: string; status: string; priority: string | null;
  notes: string | null; completedAt: string | null; failedAt: string | null; failureReason: string | null;
  rescheduleReason: string | null; occurrenceKey: string;
  plan: {
    id: string; name: string; code: string; frequency: string; planType: string; priority: string | null;
    instructions: string; safetyRequirements: string; requiredSkills: string; estimatedMinutes: number | null;
    requiredParts: { name: string; quantity: number; unit: string; inventoryItemId?: string | null }[];
    slaResponseHours: number | null; slaCompletionHours: number | null; meterInterval: number | null;
    meter: { id: string; name: string; unit: string; currentReading: number } | null;
  };
  equipment: {
    id: string; name: string; assetTag: string; criticality: string | null; model: string; manufacturer: string;
    serialNumber: string; customer: { id: string; companyName: string } | null;
    location: { id: string; name: string } | null;
    meters: { id: string; name: string; unit: string; currentReading: number }[];
  };
  technician: { id: string; employeeNo: string; user: { id: string; name: string } | null } | null;
  checklist: { id: string; label: string; done: boolean }[];
  workOrder: {
    id: string; code: string; status: string; priority: string; description: string | null;
    scheduledDate: string | null; startedAt: string | null; completedAt: string | null;
    labourHours: number | null; labourRateCents: number | null; labourTotalCents: number | null;
    materialsTotalCents: number | null; totalCents: number | null; notes: string | null;
    checklist: WOChecklistItem[];
    materials: WOMaterial[];
  } | null;
  findings: FindingRow[];
  photos: PhotoDoc[];
};

type ItemOverlay = { done?: boolean; response?: string; notes?: string };
type ExecDraft = { overlay: Record<string, ItemOverlay>; notes: string; savedAt: string };

// ── Draft protection (§29) ──

function readExecutionDraft(key: string): ExecDraft {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const saved = JSON.parse(raw) as ExecDraft;
      if (saved && typeof saved === "object") {
        return { overlay: saved.overlay ?? {}, notes: saved.notes ?? "", savedAt: saved.savedAt ?? "loaded" };
      }
    }
  } catch { /* corrupt draft — ignore */ }
  return { overlay: {}, notes: "", savedAt: "" };
}

function useExecutionDraft(taskId: string) {
  const key = `hms:draft:pm-exec-${taskId}`;
  // §29 — restore once via lazy state initializer (no ref-during-render, no effect setState).
  const [initial] = useState(() => readExecutionDraft(key));
  const [overlay, setOverlay] = useState<Record<string, ItemOverlay>>(initial.overlay);
  const [notes, setNotes] = useState(initial.notes);
  const [dirty, setDirty] = useState(initial.savedAt !== "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<ExecDraft>(initial);

  const persist = useCallback((next: ExecDraft) => {
    stateRef.current = next;
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable */ }
  }, [key]);

  const schedule = useCallback((next: ExecDraft) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(next), 800);
  }, [persist]);

  const recordItem = useCallback((itemId: string, patch: ItemOverlay) => {
    setOverlay((prev) => {
      const next = { ...prev, [itemId]: { ...prev[itemId], ...patch } };
      setDirty(true);
      schedule({ overlay: next, notes: stateRef.current.notes, savedAt: new Date().toISOString() });
      return next;
    });
  }, [schedule]);

  const recordNotes = useCallback((value: string) => {
    setNotes(value);
    setDirty(true);
    schedule({ overlay: stateRef.current.overlay, notes: value, savedAt: new Date().toISOString() });
  }, [schedule]);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    try { localStorage.removeItem(key); } catch { /* noop */ }
    stateRef.current = { overlay: {}, notes: "", savedAt: "" };
    setOverlay({});
    setNotes("");
    setDirty(false);
  }, [key]);

  // §29 — browser-level guard while the execution draft is dirty.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return { overlay, notes, dirty, recordItem, recordNotes, clear, persist };
}

// ── Page ──

export function PmTaskDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.pm_manage);
  const canExecute = hasPerm(user, PERMISSIONS.pm_execute) || canManage;
  const isCustomer = user?.role === "CUSTOMER";

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [failOpen, setFailOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState("");

  const draft = useExecutionDraft(id);

  useEffect(() => { setPageDirty(draft.dirty); return () => { setPageDirty(false); }; }, [draft.dirty, setPageDirty]);

  const load = useCallback(async () => {
    try {
      const res = await api.get<TaskDetail>(`/api/v1/pm/tasks/${encodeURIComponent(id)}`);
      setTask(res.data);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this PM task.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.pm, () => { void load(); });

  // ── WO lifecycle (the canonical state machine for linked occurrences) ──
  const woTransition = async (action: "accept" | "start" | "resume" | "complete") => {
    if (!task?.workOrder) return;
    setBusy(`wo-${action}`);
    setCompleteError(null);
    try {
      await api.post(`/api/v1/work-orders/${task.workOrder.id}/transition`, action === "complete" ? { action, note: draft.notes || undefined } : { action });
      if (action === "complete") {
        draft.clear();
        toast({ title: "PM completed", description: `${task.code} closed — the plan schedule advanced automatically.` });
      } else {
        toast({ title: `Work order ${action === "resume" ? "resumed" : action + "ed"}`, description: `${task.workOrder.code} → ${action === "resume" ? "In Progress" : humanize(action)}` });
      }
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transition failed.";
      if (e instanceof ClientApiError && e.status === 422) {
        // Backend-authoritative checklist guard — surface the message verbatim.
        setCompleteError(msg);
        toast({ title: "Cannot complete yet", description: msg, variant: "destructive" });
      } else {
        toast({ title: "Action failed", description: msg, variant: "destructive" });
      }
    } finally {
      setBusy(null);
    }
  };

  if (loading && !task) {
    return (
      <PageShell backLabel="Back to PM Schedule" backHref="/pm?tab=schedule" title="PM task">
        <LoadingState label="Loading task…" rows={4} />
      </PageShell>
    );
  }
  if (loadError && !task) {
    return (
      <PageShell backLabel="Back to PM Schedule" backHref="/pm?tab=schedule" title="PM task">
        <ErrorState message={loadError} onRetry={() => void load()} />
      </PageShell>
    );
  }
  if (!task) {
    return (
      <PageShell backLabel="Back to PM Schedule" backHref="/pm?tab=schedule" title="PM task">
        <EmptyState title="Task not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const overdue = isTaskOpen(task.status) ? daysOverdue(task.dueDate) : 0;
  const wo = task.workOrder;
  const isClosed = !isTaskOpen(task.status);

  return (
    <PageShell
      backLabel="Back to PM Schedule"
      backHref="/pm?tab=schedule"
      crumbs={[
        { label: "Preventive Maintenance", href: "/pm" },
        { label: "Schedule", href: "/pm?tab=schedule" },
        { label: task.code },
      ]}
      title={`${task.code} — ${task.plan.name}`}
      description={`Due ${fmtDate(task.dueDate)}${overdue > 0 ? ` · ${overdue} day${overdue === 1 ? "" : "s"} overdue` : ""} · ${task.plan.estimatedMinutes ?? 60} min estimated`}
      actions={
        <div className="flex flex-wrap items-center gap-2 no-print">
          <PriorityBadge priority={task.priority} />
          <StatusBadge status={task.status} />
          {wo ? (
            <button type="button" onClick={() => navigateTo("work-orders", [wo.id])} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-mono hover:bg-accent/60 min-h-[44px] sm:min-h-0">
              <Link2 className="h-3.5 w-3.5" /> {wo.code}
            </button>
          ) : null}
        </div>
      }
    >
      {overdue > 0 && !isClosed ? (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <span>This occurrence is <strong>{overdue} day{overdue === 1 ? "" : "s"} overdue</strong> — completing it now records today's date and counts as late for compliance.</span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3 pb-24 sm:pb-0">
        {/* Left column: equipment + plan guidance */}
        <div className="space-y-4">
          <Card className="shadow-sm">
            <CardHeader className="pb-3"><CardTitle className="text-base">Equipment</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <a href={`/equipment/${encodeURIComponent(task.equipment.id)}`} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 min-h-[44px] hover:bg-accent/60 transition-colors">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{task.equipment.name}</span>
                  <span className="block text-xs text-muted-foreground">{task.equipment.assetTag}</span>
                </span>
                <PriorityBadge priority={task.equipment.criticality} />
              </a>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <LabelValue label="Customer" value={customerLabel(task.equipment.customer)} />
                <LabelValue label="Location" value={task.equipment.location?.name ?? "—"} />
                <LabelValue label="Serial" value={<span className="font-mono text-xs">{task.equipment.serialNumber || "—"}</span>} />
                <LabelValue label="Model" value={[task.equipment.manufacturer, task.equipment.model].filter(Boolean).join(" ") || "—"} />
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ClipboardCheck className="h-4 w-4 text-primary" /> Plan guidance
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {task.plan.safetyRequirements ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300 mb-1"><ShieldAlert className="h-3.5 w-3.5" /> SAFETY REQUIREMENTS</p>
                  <p className="whitespace-pre-wrap text-sm text-amber-900 dark:text-amber-200">{task.plan.safetyRequirements}</p>
                </div>
              ) : null}
              {task.plan.instructions ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Instructions</p>
                  <p className="whitespace-pre-wrap">{task.plan.instructions}</p>
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {task.plan.requiredSkills ? <LabelValue label="Required skills" value={<span className="font-normal">{task.plan.requiredSkills}</span>} className="col-span-2" /> : null}
                <LabelValue label="Estimated duration" value={`${task.plan.estimatedMinutes ?? 60} min`} />
                {task.plan.slaResponseHours ? <LabelValue label="SLA response" value={`${task.plan.slaResponseHours} h`} /> : null}
                {task.plan.slaCompletionHours ? <LabelValue label="SLA completion" value={`${task.plan.slaCompletionHours} h`} /> : null}
              </div>
              {task.plan.requiredParts.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">Required parts</p>
                  <div className="space-y-1.5">
                    {task.plan.requiredParts.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
                        <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="flex-1 min-w-0 truncate">{p.name}</span>
                        <span className="text-muted-foreground whitespace-nowrap">{p.quantity} {p.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {isCustomer ? null : <FindingsCard task={task} onAdded={() => void load()} canManage={canManage} canExecute={canExecute} />}
        </div>

        {/* Middle + right: execution */}
        <div className="space-y-4 lg:col-span-2">
          {wo ? (
            <ExecutionCard
              task={task} wo={wo}
              isCustomer={isCustomer} canExecute={canExecute}
              busy={busy} onTransition={(a) => void woTransition(a)}
              draftNotes={draft.notes} onNotesChange={draft.recordNotes}
            />
          ) : (
            <Card className="shadow-sm">
              <CardHeader className="pb-3"><CardTitle className="text-base">Execution</CardTitle></CardHeader>
              <CardContent>
                <EmptyState title="No execution work order" hint="This is a legacy occurrence without a linked work order — lifecycle actions run directly on the task." />
                {canExecute && !isClosed ? (
                  <div className="mt-3">
                    <Button variant="outline" size="sm" className="min-h-[44px]" disabled={busy === "task-start" || task.status === "IN_PROGRESS"} onClick={async () => {
                      setBusy("task-start");
                      try {
                        await api.post(`/api/v1/pm/tasks/${task.id}/transition`, { action: "start" });
                        toast({ title: "Task started" });
                        await load();
                      } catch (e) {
                        toast({ title: "Could not start", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
                      } finally { setBusy(null); }
                    }}>
                      <Play className="h-4 w-4 mr-1.5" /> Start task
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}

          {wo && !isCustomer ? (
            <ChecklistCard
              wo={wo} overlay={draft.overlay}
              disabled={wo.status === "COMPLETED" || wo.status === "CANCELLED" || !canExecute}
              busy={busy}
              onPatch={async (itemId, patch) => {
                setBusy(`chk-${itemId}`);
                draft.recordItem(itemId, patch); // §29 — persist intent before the wire
                try {
                  await api.patch(`/api/v1/work-orders/${wo.id}/checklist`, { itemId, ...patch });
                  await load();
                } catch (e) {
                  toast({ title: "Checklist update failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
                } finally {
                  setBusy(null);
                }
              }}
            />
          ) : wo ? (
            <Card className="shadow-sm">
              <CardHeader className="pb-3"><CardTitle className="text-base">Checklist ({wo.checklist.length})</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {wo.checklist.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm">
                    {c.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" /> : <CircleDashed className="h-4 w-4 text-muted-foreground shrink-0" />}
                    <span className="flex-1 min-w-0">{c.label}</span>
                    {c.required ? <Badge variant="outline" className="border-transparent bg-red-100 text-red-700">Required</Badge> : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {wo && !isCustomer ? <MaterialsCard task={task} onChanged={() => void load()} /> : null}
          <PhotosCard task={task} onChanged={() => void load()} />
          <MeterCard task={task} onRecorded={() => void load()} />
        </div>
      </div>

      {/* Sticky action footer (mobile-first) */}
      {!isCustomer && wo && !isClosed ? (
        <div className="sticky bottom-[4.4rem] lg:bottom-4 z-30 no-print">
          <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3">
            {completeError ? (
              <div role="alert" className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0">{completeError}</span>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="flex-1 min-h-[44px]"
                disabled={busy !== null || wo.status !== "IN_PROGRESS"}
                onClick={() => void woTransition("complete")}
                title={wo.status !== "IN_PROGRESS" ? "Start the work order first" : "Close this occurrence"}
              >
                {busy === "wo-complete" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
                {busy === "wo-complete" ? "Completing…" : "Complete PM"}
              </Button>
              {canExecute ? (
                <Button variant="outline" className="min-h-[44px] text-destructive hover:text-destructive" disabled={busy !== null} onClick={() => setFailOpen(true)}>
                  <Flag className="h-4 w-4 mr-1.5" /> Mark failed
                </Button>
              ) : null}
              {canManage ? (
                <>
                  <Button variant="outline" className="min-h-[44px]" disabled={busy !== null} onClick={() => setRescheduleOpen(true)}>
                    <CalendarIcon className="h-4 w-4 mr-1.5" /> Reschedule
                  </Button>
                  <Button variant="outline" className="min-h-[44px]" disabled={busy !== null} onClick={() => setSkipOpen(true)}>
                    <CircleOff className="h-4 w-4 mr-1.5" /> Skip
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Mark failed (§75) — finding modal */}
      <FailDialog
        key={failOpen ? "open" : "closed"}
        open={failOpen} onOpenChange={setFailOpen}
        busy={busy === "fail"}
        onSubmit={async (finding) => {
          setBusy("fail");
          try {
            await api.post(`/api/v1/pm/tasks/${task.id}/transition`, { action: "fail", finding });
            toast({ title: "PM marked failed", description: `${task.code} recorded as FAILED with a finding — supervisors were notified.`, variant: "destructive" });
            setFailOpen(false);
            draft.clear();
            await load();
          } catch (e) {
            toast({ title: "Could not mark failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
          } finally { setBusy(null); }
        }}
      />

      {/* Reschedule (pm_manage) */}
      <RescheduleDialog
        key={rescheduleOpen ? "open" : "closed"}
        open={rescheduleOpen} onOpenChange={setRescheduleOpen}
        busy={busy === "reschedule"}
        onSubmit={async (dueDate, reason) => {
          setBusy("reschedule");
          try {
            await api.post(`/api/v1/pm/tasks/${task.id}/reschedule`, { dueDate, reason });
            toast({ title: "Occurrence rescheduled", description: `${task.code} → due ${fmtDate(dueDate)}. The original date is kept for compliance history.` });
            setRescheduleOpen(false);
            await load();
          } catch (e) {
            toast({ title: "Could not reschedule", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
          } finally { setBusy(null); }
        }}
      />

      {/* Skip (pm_manage, §74) */}
      <AlertDialog open={skipOpen} onOpenChange={(open) => { if (!open && busy !== "skip") setSkipOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Skip this occurrence?</AlertDialogTitle>
            <AlertDialogDescription>
              {task.code} will be marked SKIPPED (never counted for compliance) and its execution work order is cancelled. The plan schedule is not advanced.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pm-skip-reason">Reason (recorded for audit)</Label>
            <Textarea id="pm-skip-reason" rows={2} value={skipReason} onChange={(e) => setSkipReason(e.target.value)} placeholder="e.g. Equipment already serviced under warranty visit" className="min-h-[44px]" />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "skip"}>Keep task</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "skip"}
              onClick={(e) => {
                e.preventDefault();
                setBusy("skip");
                api.post(`/api/v1/pm/tasks/${task.id}/transition`, { action: "skip", notes: skipReason || undefined })
                  .then(async () => {
                    toast({ title: "Occurrence skipped", description: `${task.code} marked SKIPPED.` });
                    setSkipOpen(false);
                    setSkipReason("");
                    await load();
                  })
                  .catch((err: unknown) => toast({ title: "Could not skip", description: err instanceof Error ? err.message : undefined, variant: "destructive" }))
                  .finally(() => setBusy(null));
              }}
            >
              {busy === "skip" ? "Skipping…" : "Skip occurrence"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}

// ── Execution card: canonical WO lifecycle ──

const WO_STEPS = ["PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED"] as const;

function ExecutionCard({ task, wo, isCustomer, canExecute, busy, onTransition, draftNotes, onNotesChange }: {
  task: TaskDetail;
  wo: NonNullable<TaskDetail["workOrder"]>;
  isCustomer: boolean; canExecute: boolean; busy: string | null;
  onTransition: (action: "accept" | "start" | "resume" | "complete") => void;
  draftNotes: string; onNotesChange: (v: string) => void;
}) {
  const stepIdx = WO_STEPS.indexOf(wo.status as (typeof WO_STEPS)[number]);
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Wrench className="h-4 w-4 text-primary" /> Execution
          <span className="ml-auto text-xs font-normal text-muted-foreground">WO {wo.code}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status timeline */}
        <ol className="grid grid-cols-4 gap-1" aria-label="Work order progress">
          {WO_STEPS.map((s, i) => {
            const reached = stepIdx >= i && stepIdx !== -1;
            return (
              <li key={s} className="flex flex-col items-center gap-1 text-center">
                <span className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold",
                  reached ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30 text-muted-foreground"
                )}>
                  {reached ? <Check className="h-4 w-4" /> : i + 1}
                </span>
                <span className={cn("text-[10px] sm:text-xs font-medium", reached ? "text-foreground" : "text-muted-foreground")}>{humanize(s)}</span>
              </li>
            );
          })}
        </ol>
        {wo.status === "ON_HOLD" ? (
          <div className="flex items-center gap-2 rounded-lg border border-orange-500/40 bg-orange-500/10 p-2.5 text-xs text-orange-800 dark:text-orange-300">
            <PauseCircle className="h-4 w-4 shrink-0" /> Work order is ON HOLD.
          </div>
        ) : null}
        {wo.status === "CANCELLED" ? (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2.5 text-xs text-red-700 dark:text-red-400">
            <X className="h-4 w-4 shrink-0" /> Work order was cancelled.
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <LabelValue label="Assigned technician" value={task.technician?.user?.name ?? "Unassigned"} />
          <LabelValue label="Started" value={fmtDateTime(wo.startedAt)} />
          <LabelValue label="Completed" value={fmtDateTime(wo.completedAt)} />
          {!isCustomer && wo.totalCents !== null && wo.totalCents !== undefined ? (
            <LabelValue label="Cost so far" value={<Money cents={wo.totalCents} className="tabular-nums" />} />
          ) : null}
        </div>

        {/* Lifecycle buttons — the WO API is the single state machine (§22) */}
        {!isCustomer && canExecute && !["COMPLETED", "CANCELLED"].includes(wo.status) ? (
          <div className="flex flex-wrap items-center gap-2">
            {wo.status === "PENDING" ? (
              <Button variant="outline" size="sm" className="min-h-[44px]" disabled={busy !== null} onClick={() => onTransition("accept")}>
                {busy === "wo-accept" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Check className="h-4 w-4 mr-1.5" />} Accept
              </Button>
            ) : null}
            {wo.status === "ACCEPTED" ? (
              <Button size="sm" className="min-h-[44px]" disabled={busy !== null} onClick={() => onTransition("start")}>
                {busy === "wo-start" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />} Start work
              </Button>
            ) : null}
            {wo.status === "ON_HOLD" ? (
              <Button size="sm" className="min-h-[44px]" disabled={busy !== null} onClick={() => onTransition("resume")}>
                {busy === "wo-resume" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />} Resume
              </Button>
            ) : null}
          </div>
        ) : null}

        {!isCustomer ? (
          <div className="space-y-1.5">
            <Label htmlFor="pm-exec-notes">Completion notes (sent with Complete)</Label>
            <Textarea
              id="pm-exec-notes" rows={2} className="min-h-[44px]"
              value={draftNotes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="Observations, parts replaced, follow-ups… (auto-saved as a draft)"
              disabled={!canExecute || ["COMPLETED", "CANCELLED"].includes(wo.status)}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Checklist card: rich recording against the WO checklist API ──

function ChecklistCard({ wo, overlay, disabled, busy, onPatch }: {
  wo: NonNullable<TaskDetail["workOrder"]>;
  overlay: Record<string, ItemOverlay>;
  disabled: boolean; busy: string | null;
  onPatch: (itemId: string, patch: ItemOverlay) => Promise<void>;
}) {
  const items = wo.checklist;
  const doneCount = items.filter((c) => (overlay[c.id]?.done ?? c.done)).length;
  const requiredMissing = items.filter((c) => {
    const ov = overlay[c.id] ?? {};
    const response = ov.response ?? c.response ?? "";
    const done = ov.done ?? c.done;
    return c.required && !done && !(c.responseType !== "CHECKBOX" && response.trim() !== "");
  }).length;

  const valueFor = (item: WOChecklistItem) => overlay[item.id]?.response ?? item.response ?? "";
  const notesFor = (item: WOChecklistItem) => overlay[item.id]?.notes ?? item.notes ?? "";

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-primary" /> Checklist
          <span className="ml-auto text-xs font-normal text-muted-foreground">{doneCount}/{items.length} done{requiredMissing > 0 ? ` · ${requiredMissing} required missing` : ""}</span>
        </CardTitle>
        <Progress value={items.length === 0 ? 0 : Math.round((doneCount / items.length) * 100)} className="mt-2 h-1.5" aria-label="Checklist progress" />
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No checklist items on this occurrence.</p>
        ) : null}
        {items.map((item) => {
          const ov = overlay[item.id] ?? {};
          const done = ov.done ?? item.done;
          const pending = busy === `chk-${item.id}`;
          return (
            <div key={item.id} className={cn("rounded-lg border p-3 space-y-2", done && "bg-emerald-500/[0.04] border-emerald-500/30")}>
              <div className="flex items-start gap-2.5">
                <span className="flex-1 min-w-0 text-sm font-medium">{item.label}</span>
                {item.required ? <Badge variant="outline" className="border-transparent bg-red-100 text-red-700 shrink-0">Required</Badge> : null}
                {pending ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" /> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {item.responseType === "CHECKBOX" ? (
                  <label className="flex items-center gap-2 rounded-lg border px-3 min-h-[44px] cursor-pointer hover:bg-muted/50">
                    <Checkbox
                      checked={done}
                      disabled={disabled}
                      onCheckedChange={(v) => void onPatch(item.id, { done: v === true })}
                      aria-label={item.label}
                    />
                    <span className="text-sm">{done ? "Done" : "Mark done"}</span>
                  </label>
                ) : item.responseType === "PASSFAIL" ? (
                  <div className="flex items-center gap-1.5" role="group" aria-label={`${item.label} pass or fail`}>
                    {(["PASS", "FAIL"] as const).map((val) => (
                      <Button
                        key={val} type="button" variant="outline" size="sm"
                        className={cn("min-h-[44px] min-w-[72px]", valueFor(item) === val && (val === "PASS" ? "border-emerald-500 bg-emerald-500/10 text-emerald-700" : "border-red-500 bg-red-500/10 text-red-700"))}
                        disabled={disabled}
                        onClick={() => void onPatch(item.id, { response: val })}
                      >
                        {val === "PASS" ? <Check className="h-4 w-4 mr-1" /> : <X className="h-4 w-4 mr-1" />} {val}
                      </Button>
                    ))}
                  </div>
                ) : item.responseType === "YESNO" ? (
                  <div className="flex items-center gap-1.5" role="group" aria-label={`${item.label} yes or no`}>
                    {(["YES", "NO"] as const).map((val) => (
                      <Button
                        key={val} type="button" variant="outline" size="sm"
                        className={cn("min-h-[44px] min-w-[72px]", valueFor(item) === val && "border-primary bg-primary/10")}
                        disabled={disabled}
                        onClick={() => void onPatch(item.id, { response: val })}
                      >
                        {val}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <FreeTextResponse
                    item={item} value={valueFor(item)} disabled={disabled}
                    onSubmit={(value) => void onPatch(item.id, { response: value })}
                  />
                )}
              </div>
              <ItemNotes
                value={notesFor(item)}
                disabled={disabled}
                onSubmit={(v) => { if (v) void onPatch(item.id, { notes: v }); }}
              />
            </div>
          );
        })}
        {requiredMissing > 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" /> {requiredMissing} required item{requiredMissing === 1 ? "" : "s"} still open — Complete is blocked until they are recorded.
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> All required items are recorded.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** NUMERIC / TEXT response — local edit state, PATCH on Save/blur/Enter. */
function FreeTextResponse({ item, value, disabled, onSubmit }: {
  item: WOChecklistItem; value: string; disabled: boolean; onSubmit: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState<string | null>(null);
  const shown = draftValue ?? value;
  const submit = () => {
    const v = shown.trim();
    if (!v) return;
    onSubmit(v);
    setDraftValue(null);
  };
  return (
    <div className="flex w-full items-center gap-1.5">
      <Input
        inputMode={item.responseType === "NUMERIC" ? "decimal" : "text"}
        value={shown}
        onChange={(e) => setDraftValue(e.target.value)}
        onBlur={() => { if (draftValue !== null) submit(); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        placeholder={item.responseType === "NUMERIC" ? "Record a numeric reading" : "Record observation"}
        disabled={disabled}
        className="min-h-[44px] flex-1"
        aria-label={`${item.label} response`}
      />
      <Button type="button" variant="outline" size="sm" className="min-h-[44px]" disabled={disabled || draftValue === null} onClick={submit}>
        Save
      </Button>
    </div>
  );
}

/** Per-item notes — PATCH on blur when changed. */
function ItemNotes({ value, disabled, onSubmit }: {
  value: string; disabled: boolean; onSubmit: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState<string | null>(null);
  const shown = draftValue ?? value;
  return (
    <Input
      value={shown}
      onChange={(e) => setDraftValue(e.target.value)}
      onBlur={() => {
        if (draftValue === null) return;
        const v = draftValue.trim();
        if (v !== value.trim()) onSubmit(v);
        setDraftValue(null);
      }}
      placeholder="Item notes (optional)"
      disabled={disabled}
      className="min-h-[40px] h-10 text-xs"
      aria-label="Item notes"
    />
  );
}

// ── Photos card: phase tabs + camera upload ──

const PHOTO_PHASES = ["BEFORE", "DURING", "AFTER"] as const;

function PhotosCard({ task, onChanged }: { task: TaskDetail; onChanged: () => void }) {
  const { toast } = useToast();
  const [phase, setPhase] = useState<(typeof PHOTO_PHASES)[number]>("BEFORE");
  const [photos, setPhotos] = useState<PhotoDoc[]>(task.photos ?? []);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setPhotos(task.photos ?? []); }, [task.photos]);

  const refreshPhotos = useCallback(async () => {
    try {
      const res = await api.get<PhotoDoc[]>(`/api/v1/pm/tasks/${encodeURIComponent(task.id)}/photos`);
      setPhotos(res.data ?? []);
    } catch {
      /* keep task.photos */
    }
  }, [task.id]);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    let okCount = 0;
    for (const file of Array.from(files)) {
      try {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("phase", phase);
        const res = await fetch(`/api/v1/pm/tasks/${encodeURIComponent(task.id)}/photos`, { method: "POST", body: fd, credentials: "same-origin" });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        okCount += 1;
      } catch (e) {
        toast({ title: "Photo upload failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      }
    }
    if (okCount > 0) {
      toast({ title: `${okCount} photo${okCount === 1 ? "" : "s"} uploaded`, description: `Phase: ${humanize(phase)}.` });
      await refreshPhotos();
      onChanged();
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const phasePhotos = photos.filter((p) => (p.label ?? "").toUpperCase() === phase);
  const otherCount = photos.length - phasePhotos.length;

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-primary" /> Photos
          <span className="ml-auto text-xs font-normal text-muted-foreground">{photos.length} total</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs value={phase} onValueChange={(v) => setPhase(v as (typeof PHOTO_PHASES)[number])}>
          <TabsList>
            {PHOTO_PHASES.map((p) => (
              <TabsTrigger key={p} value={p}>{humanize(p)}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {phasePhotos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No {phase.toLowerCase()} photos yet.</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 max-h-96 overflow-y-auto hms-scroll">
            {phasePhotos.map((p) => (
              <a
                key={p.id}
                href={`/api/v1/pm/photos/${encodeURIComponent(p.id)}/file`}
                target="_blank"
                rel="noreferrer"
                className="group relative block aspect-square overflow-hidden rounded-lg border bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open photo ${p.name}`}
              >
                <img
                  src={`/api/v1/pm/photos/${encodeURIComponent(p.id)}/file`}
                  alt={`${p.label ?? "PM"} photo — ${p.name}`}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                />
              </a>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Select value={phase} onValueChange={(v) => setPhase(v as (typeof PHOTO_PHASES)[number])}>
            <SelectTrigger className="w-[150px] min-h-[44px]" aria-label="Upload phase"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[...PHOTO_PHASES, "FINDING", "METER"].map((p) => <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>)}
            </SelectContent>
          </Select>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="sr-only"
            onChange={(e) => void upload(e.target.files)}
            aria-label="Photo file input"
          />
          <Button variant="outline" className="min-h-[44px]" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Camera className="h-4 w-4 mr-1.5" />}
            {uploading ? "Uploading…" : "Upload / take photo"}
          </Button>
          {otherCount > 0 ? <span className="text-xs text-muted-foreground">{otherCount} in other phases</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Findings card ──

function FindingsCard({ task, onAdded, canManage, canExecute }: { task: TaskDetail; onAdded: () => void; canManage: boolean; canExecute: boolean }) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [severity, setSeverity] = useState("MEDIUM");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [recommendation, setRecommendation] = useState("");
  const [followUp, setFollowUp] = useState(true);

  const submit = async () => {
    if (!title.trim() || title.trim().length < 3) {
      toast({ title: "Finding title is required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/v1/pm/findings", {
        pmTaskId: task.id,
        title: title.trim(),
        description: description.trim(),
        severity,
        recommendation: recommendation.trim(),
        followUpRequired: followUp,
      });
      if (severity === "HIGH" || severity === "CRITICAL") {
        toast({ title: `${humanize(severity)} finding recorded`, description: "Supervisors were notified — consider a corrective work order immediately.", variant: "destructive" });
      } else {
        toast({ title: "Finding recorded", description: title.trim() });
      }
      setAdding(false);
      setTitle(""); setDescription(""); setRecommendation(""); setSeverity("MEDIUM"); setFollowUp(true);
      onAdded();
    } catch (e) {
      toast({ title: "Could not record finding", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Flag className="h-4 w-4 text-amber-600" /> Findings
          <span className="ml-auto text-xs font-normal text-muted-foreground">({task.findings.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {task.findings.length === 0 && !adding ? (
          <p className="text-sm text-muted-foreground">No findings on this occurrence.</p>
        ) : null}
        {task.findings.map((f) => (
          <div key={f.id} className="rounded-lg border p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <PriorityBadge priority={f.severity} />
              <p className="text-sm font-medium flex-1 min-w-0">{f.title}</p>
            </div>
            {f.description ? <p className="text-xs text-muted-foreground whitespace-pre-wrap">{f.description}</p> : null}
            {f.recommendation ? <p className="text-xs"><span className="font-medium">Recommendation:</span> {f.recommendation}</p> : null}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {f.followUpRequired ? <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800">Follow-up required</Badge> : null}
              {f.correctiveWorkOrder ? (
                <button type="button" onClick={() => navigateTo("work-orders", [f.correctiveWorkOrder!.id])} className="font-mono text-primary hover:underline">
                  {f.correctiveWorkOrder.code}
                </button>
              ) : null}
            </div>
          </div>
        ))}

        {adding ? (
          <div className="space-y-2.5 rounded-lg border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="pm-f-severity">Severity</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger className="min-h-[44px]" aria-label="Severity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PM_FINDING_SEVERITIES.map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pm-f-title">Title *</Label>
              <Input id="pm-f-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is wrong with the equipment?" className="min-h-[44px]" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pm-f-desc">Description</Label>
              <Textarea id="pm-f-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[44px]" placeholder="Observed condition, measurements…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pm-f-rec">Recommendation</Label>
              <Textarea id="pm-f-rec" rows={2} value={recommendation} onChange={(e) => setRecommendation(e.target.value)} className="min-h-[44px]" placeholder="Suggested corrective action" />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={followUp} onCheckedChange={(v) => setFollowUp(v === true)} aria-label="Follow-up required" />
              Follow-up required
            </label>
            <div className="flex items-center gap-2">
              <Button size="sm" className="min-h-[44px] flex-1" disabled={busy} onClick={() => void submit()}>
                {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />} Record finding
              </Button>
              <Button size="sm" variant="ghost" className="min-h-[44px]" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button>
            </div>
          </div>
        ) : canManage || canExecute ? (
          <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Add finding
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Materials card (WO materials API) ──

function MaterialsCard({ task, onChanged }: { task: TaskDetail; onChanged: () => void }) {
  const { toast } = useToast();
  const wo = task.workOrder;
  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);

  if (!wo) return null;
  const closed = ["COMPLETED", "CANCELLED"].includes(wo.status);

  const add = async () => {
    if (!name.trim() || Number(qty) <= 0) {
      toast({ title: "Material name and a positive quantity are required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/v1/work-orders/${wo.id}/materials`, {
        name: name.trim(),
        quantity: Number(qty),
        ...(unit.trim() ? { unit: unit.trim() } : {}),
        unitCostCents: cost ? toCents(cost) : 0,
      });
      toast({ title: "Material added", description: `${name.trim()} × ${qty} — stock deducts when the work order completes.` });
      setName(""); setQty("1"); setUnit(""); setCost("");
      onChanged();
    } catch (e) {
      toast({ title: "Could not add material", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: WOMaterial) => {
    setBusy(true);
    try {
      await api.del(`/api/v1/work-orders/${wo.id}/materials?materialId=${encodeURIComponent(m.id)}`);
      toast({ title: "Material removed", description: m.name });
      onChanged();
    } catch (e) {
      toast({ title: "Could not remove material", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="h-4 w-4 text-primary" /> Materials
          {!closed ? <span className="ml-auto text-xs font-normal text-muted-foreground">stock deducts on completion</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {wo.materials.length === 0 ? (
          <p className="text-sm text-muted-foreground">No materials recorded.</p>
        ) : (
          <div className="divide-y rounded-lg border max-h-64 overflow-y-auto hms-scroll">
            {wo.materials.map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="flex-1 min-w-0 truncate">{m.name}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">× {m.quantity}{m.inventoryItem ? ` ${m.inventoryItem.unit}` : ""}</span>
                <Money cents={m.totalCents} className="tabular-nums whitespace-nowrap" />
                {!closed ? (
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive hover:text-destructive" disabled={busy} onClick={() => void remove(m)} aria-label={`Remove ${m.name}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {wo.materialsTotalCents !== null && wo.materialsTotalCents !== undefined ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Materials total</span>
            <Money cents={wo.materialsTotalCents} className="font-medium tabular-nums" />
          </div>
        ) : null}
        {!closed ? (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Material name" className="min-h-[44px] col-span-2 sm:col-span-1 sm:col-span-2" aria-label="Material name" />
              <Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ""))} placeholder="Qty" className="min-h-[44px]" aria-label="Quantity" />
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit" className="min-h-[44px]" aria-label="Unit" />
            </div>
            <div className="flex items-center gap-2">
              <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ""))} placeholder="Unit cost (BND, optional)" className="min-h-[44px] flex-1" aria-label="Unit cost" />
              <Button variant="outline" className="min-h-[44px]" disabled={busy} onClick={() => void add()}>
                {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />} Add
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Meter card (readings + triggered plans) ──

function MeterCard({ task, onRecorded }: { task: TaskDetail; onRecorded: () => void }) {
  const { toast } = useToast();
  const meters = task.equipment.meters ?? [];
  const [reading, setReading] = useState<Record<string, string>>({});
  const [busyMeterId, setBusyMeterId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  if (meters.length === 0) return null;

  const record = async (meterId: string) => {
    const value = Number((reading[meterId] ?? "").replace(/[^\d.]/g, ""));
    if (!value || value <= 0) {
      toast({ title: "Enter a positive reading first", variant: "destructive" });
      return;
    }
    setBusyMeterId(meterId);
    try {
      const res = await api.post<{ reading: number; triggeredPlans?: { planId: string; code: string }[] }>(
        "/api/v1/pm/meter-readings",
        { meterId, reading: value, ...(notes[meterId] ? { notes: notes[meterId] } : {}) }
      );
      const triggered = res.data.triggeredPlans ?? [];
      toast({
        title: "Reading recorded",
        description: triggered.length > 0
          ? `Plans due: ${triggered.map((p) => p.code).join(", ")} — generate occurrences from the plan.`
          : "Recorded successfully.",
      });
      setReading((p) => ({ ...p, [meterId]: "" }));
      onRecorded();
    } catch (e) {
      toast({ title: "Could not record reading", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyMeterId(null);
    }
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Droplets className="h-4 w-4 text-primary" /> Meters
          {task.plan.meterInterval ? <span className="ml-auto text-xs font-normal text-muted-foreground">plan interval: {task.plan.meterInterval} units</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {meters.map((m) => (
          <div key={m.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{m.name}</p>
                <p className="text-xs text-muted-foreground">Current: <span className="font-semibold tabular-nums">{m.currentReading}</span> {m.unit}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input
                inputMode="decimal"
                value={reading[m.id] ?? ""}
                onChange={(e) => setReading((p) => ({ ...p, [m.id]: e.target.value }))}
                placeholder={`New reading (${m.unit})`}
                className="min-h-[44px] flex-1"
                aria-label={`${m.name} new reading`}
              />
              <Button variant="outline" className="min-h-[44px]" disabled={busyMeterId === m.id} onClick={() => void record(m.id)}>
                {busyMeterId === m.id ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />} Record
              </Button>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Meter plans trigger automatically when a reading crosses the threshold.</p>
      </CardContent>
    </Card>
  );
}

// ── Fail dialog (§75 — finding is mandatory) ──

function FailDialog({ open, onOpenChange, busy, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; busy: boolean;
  onSubmit: (finding: { title: string; description: string; severity: string; cause: string; recommendation: string; immediateAction: string; followUpRequired: boolean }) => Promise<void>;
}) {
  const { toast } = useToast();
  const [severity, setSeverity] = useState("HIGH");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cause, setCause] = useState("");
  const [recommendation, setRecommendation] = useState("");
  const [immediateAction, setImmediateAction] = useState("");
  const [followUp, setFollowUp] = useState(true);

  const submit = async () => {
    if (title.trim().length < 3) {
      toast({ title: "Describe the failure (min 3 characters)", variant: "destructive" });
      return;
    }
    await onSubmit({
      title: title.trim(), description: description.trim(), severity, cause: cause.trim(),
      recommendation: recommendation.trim(), immediateAction: immediateAction.trim(), followUpRequired: followUp,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto hms-scroll">
        <DialogHeader>
          <DialogTitle>Mark PM as failed</DialogTitle>
          <DialogDescription>
            The equipment could not be serviced (unsafe, defective, access blocked…). A finding is recorded, the occurrence becomes FAILED and supervisors are notified.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Severity</Label>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger className="min-h-[44px]" aria-label="Severity"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PM_FINDING_SEVERITIES.map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pm-fail-title">What is wrong? *</Label>
            <Input id="pm-fail-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Compressor seized — unit unsafe to run" className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pm-fail-desc">Description</Label>
            <Textarea id="pm-fail-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pm-fail-cause">Probable cause</Label>
            <Input id="pm-fail-cause" value={cause} onChange={(e) => setCause(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pm-fail-rec">Recommendation</Label>
            <Textarea id="pm-fail-rec" rows={2} value={recommendation} onChange={(e) => setRecommendation(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pm-fail-action">Immediate action taken</Label>
            <Textarea id="pm-fail-action" rows={2} value={immediateAction} onChange={(e) => setImmediateAction(e.target.value)} className="min-h-[44px]" placeholder="e.g. Unit isolated and tagged out" />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={followUp} onCheckedChange={(v) => setFollowUp(v === true)} aria-label="Follow-up required" />
            Corrective follow-up required
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Flag className="h-4 w-4 mr-1.5" />}
            {busy ? "Recording…" : "Mark failed"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Reschedule dialog (pm_manage) ──

function RescheduleDialog({ open, onOpenChange, busy, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; busy: boolean;
  onSubmit: (dueDate: string, reason: string) => Promise<void>;
}) {
  const { toast } = useToast();
  // Fresh defaults every time the dialog opens (remount via key on the parent).
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [reason, setReason] = useState("");

  const submit = async () => {
    if (!dueDate) {
      toast({ title: "Pick a new due date", variant: "destructive" });
      return;
    }
    await onSubmit(dueDate, reason.trim());
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reschedule occurrence</DialogTitle>
          <DialogDescription>
            Moves the due date forward. The original date stays in history for compliance reporting, and the reason is recorded for audit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pm-resched-date">New due date *</Label>
            <Input id="pm-resched-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pm-resched-reason">Reason *</Label>
            <Textarea id="pm-resched-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-[44px]" placeholder="e.g. Site access only possible next week" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !dueDate || !reason.trim()}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CalendarIcon className="h-4 w-4 mr-1.5" />}
            {busy ? "Rescheduling…" : "Reschedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
