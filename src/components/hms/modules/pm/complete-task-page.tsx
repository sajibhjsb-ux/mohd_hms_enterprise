"use client";

// MOHD.HMS ENTERPRISE — dedicated "Complete PM Task" page (pm/{taskId}/complete view).
// Replaces the old complete-task dialog: task meta card, checklist switches,
// notes and a Complete action that stays disabled until every item is done.
// Reuses the existing PM tasks API + RBAC — no new APIs.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate, fmtDateTime } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, CheckCircle2, Flag, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type EquipmentRef = { id: string; assetTag: string; name: string };
type TechnicianRef = { id: string; employeeNo: string; user: { id: string; name: string } | null };
type ChecklistItem = { id: string; label: string; done: boolean; sortOrder: number };

type PmTask = {
  id: string;
  code: string;
  dueDate: string;
  status: string;
  completedAt: string | null;
  notes: string;
  plan: { id: string; name: string; code: string } | null;
  equipment: EquipmentRef | null;
  technician: TechnicianRef | null;
  checklist?: ChecklistItem[];
};

// ── Page ──

export function PmCompleteTaskPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);

  // The Complete action on the list was gated with pm.manage OR pm.execute — mirror it.
  const canExecute = hasPerm(user, PERMISSIONS.pm_execute) || hasPerm(user, PERMISSIONS.pm_manage);

  const [task, setTask] = useState<PmTask | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<PmTask>(`/api/v1/pm/tasks/${id}`);
      setTask(res.data);
      setItems(res.data.checklist ?? []);
      setNotes(res.data.notes ?? "");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Unable to load this PM task.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Notes editing marks the page dirty so the central unsaved-changes guard applies;
  // the cleanup releases the guard when the page unmounts.
  useEffect(() => {
    return () => { setPageDirty(false); };
  }, [setPageDirty]);

  const onNotesChange = (value: string) => {
    setNotes(value);
    setPageDirty(true);
  };

  const allDone = items.length === 0 || items.every((i) => i.done);
  const doneCount = items.filter((i) => i.done).length;
  const isOverdue = task ? task.status === "OVERDUE" || (["SCHEDULED", "IN_PROGRESS"].includes(task.status) && new Date(task.dueDate) < new Date()) : false;
  const isActive = task ? ["SCHEDULED", "OVERDUE", "IN_PROGRESS"].includes(task.status) : false;

  async function submitComplete() {
    if (!task) return;
    if (!allDone) {
      toast({ title: "Checklist incomplete", description: "Tick off every checklist item before completing.", variant: "destructive" });
      return;
    }
    setCompleting(true);
    try {
      await api.post(`/api/v1/pm/tasks/${task.id}/transition`, {
        action: "complete",
        notes: notes || undefined,
        checklist: items.map((i) => ({ id: i.id, done: i.done })),
      });
      toast({ title: "PM completed", description: `${task.code} marked as completed.` });
      setPageDirty(false);
      navigateTo("pm");
    } catch (e) {
      // Keep the entered notes + checklist state so the user can retry.
      toast({ title: "Could not complete task", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setCompleting(false);
    }
  }

  const backLabel = "Back to Preventive Maintenance";
  const backHref = "/pm";

  if (!canExecute) {
    return (
      <PageShell backLabel={backLabel} backHref={backHref} title="Complete task">
        <EmptyState
          title="You don't have permission to complete PM tasks"
          hint="Completing maintenance tasks is limited to technicians, supervisors, admins and super admins. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  if (loading && !task) {
    return (
      <PageShell backLabel={backLabel} backHref={backHref} title="Complete task">
        <LoadingState label="Loading task…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !task) {
    return (
      <PageShell backLabel={backLabel} backHref={backHref} title="Complete task">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!task) {
    return (
      <PageShell backLabel={backLabel} backHref={backHref} title="Complete task">
        <EmptyState title="Task not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const taskLabel = task.code;

  return (
    <PageShell
      backLabel={backLabel}
      backHref={backHref}
      crumbs={[
        { label: "Preventive Maintenance", href: "/pm" },
        { label: "Tasks", href: "/pm" },
        { label: taskLabel },
        { label: "Complete" },
      ]}
      title={`Complete ${task.code}`}
      description={task.plan?.name ? `${task.plan.name} — tick every checklist item, add notes, then complete.` : "Tick every checklist item, add notes, then complete."}
      actions={
        <div className="hidden sm:flex items-center gap-2">
          <StatusBadge status={task.status} />
          <Button
            onClick={() => void submitComplete()}
            disabled={completing || !isActive || !allDone}
            title={!isActive ? "This task is no longer active" : !allDone ? "Complete every checklist item first" : undefined}
          >
            {completing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Flag className="h-4 w-4 mr-1.5" />}
            {completing ? "Completing…" : "Complete Task"}
          </Button>
        </div>
      }
    >
      {!isActive ? (
        <EmptyState
          title={`Task is ${task.status.toLowerCase().replaceAll("_", " ")}`}
          hint={task.completedAt ? `This task was completed ${fmtDateTime(task.completedAt)} — nothing left to do.` : "Only scheduled, overdue or in-progress tasks can be completed."}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Task info */}
          <Card className="shadow-sm lg:col-span-1">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Task information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Code</span>
                <span className="font-medium font-mono text-xs">{task.code}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Plan</span>
                <span className="font-medium text-right truncate">{task.plan?.name ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Equipment</span>
                <span className="font-medium text-right truncate">
                  {task.equipment ? `${task.equipment.name} (${task.equipment.assetTag})` : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Technician</span>
                <span className="font-medium text-right truncate">{task.technician?.user?.name ?? "Unassigned"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Due date</span>
                <span className={cn("font-medium", isOverdue ? "text-red-600" : "")}>
                  {fmtDate(task.dueDate)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Status</span>
                <StatusBadge status={task.status} />
              </div>
              {isOverdue ? (
                <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
                  <span>This task is <span className="font-semibold">overdue</span> — completing it now will still record today's date.</span>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Checklist + notes */}
          <div className="lg:col-span-2 space-y-4">
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Checklist ({doneCount}/{items.length} done)</CardTitle>
              </CardHeader>
              <CardContent>
                {items.length > 0 ? (
                  <div className="space-y-2">
                    {items.map((item) => (
                      <label
                        key={item.id}
                        className="flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer hover:bg-muted/50"
                      >
                        <Switch
                          checked={item.done}
                          onCheckedChange={(v) => setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, done: v } : i)))}
                          aria-label={item.label}
                        />
                        <span className={cn("text-sm", item.done ? "line-through text-muted-foreground" : "")}>{item.label}</span>
                      </label>
                    ))}
                    {!allDone ? (
                      <p className="text-xs text-muted-foreground">
                        {items.length - doneCount} item{items.length - doneCount === 1 ? "" : "s"} remaining — Complete is enabled once every item is ticked off.
                      </p>
                    ) : (
                      <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                        <CheckCircle2 className="h-3.5 w-3.5" /> All checklist items are done.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">This task has no checklist items — you can complete it directly.</p>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Notes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                <Label htmlFor="pm-complete-notes">Observations &amp; follow-ups</Label>
                <Textarea
                  id="pm-complete-notes"
                  rows={4}
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder="Observations, parts replaced, follow-ups…"
                />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Sticky mobile action bar */}
      {isActive ? (
        <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
          <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3">
            <Button
              className="w-full"
              onClick={() => void submitComplete()}
              disabled={completing || !allDone}
              title={!allDone ? "Complete every checklist item first" : undefined}
            >
              {completing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Flag className="h-4 w-4 mr-1.5" />}
              {completing ? "Completing…" : "Complete Task"}
            </Button>
            {!allDone ? (
              <p className="mt-2 text-center text-xs text-muted-foreground">Complete every checklist item first.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
