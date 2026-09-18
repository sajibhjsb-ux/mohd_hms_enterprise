"use client";

// Preventive Maintenance module — plan register + task execution.
// Plans: create (dedicated page), activate/deactivate inline, generate tasks.
// Tasks: lifecycle actions (start inline / complete on a dedicated page /
// skip with an AlertDialog confirmation), overdue highlighting.
//
// NAVIGATION ARCHITECTURE (hash router, ui-store pages["pm"]):
//   []                    → this list page (Plans / Tasks tabs)
//   ["new"]               → PmNewPage            (dedicated create-plan page)
//   [taskId, "complete"]  → PmCompleteTaskPage   (dedicated complete-task page)

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock, CalendarCheck2, AlarmClock, CheckCircle2, Play, Zap,
  ClipboardList, RotateCw, Plus, CircleOff,
} from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate } from "@/lib/hms/format";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge, DrilldownChips,
} from "@/components/hms/shared/ui-bits";
import { useModuleQuery } from "@/lib/hms/page-query";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PmNewPage } from "./new-page";
import { PmCompleteTaskPage } from "./complete-task-page";

// ── Types ──

type EquipmentRef = { id: string; assetTag: string; name: string };
type TechnicianRef = { id: string; employeeNo: string; user: { id: string; name: string } | null };

type PmPlan = {
  id: string;
  code: string;
  name: string;
  frequency: string;
  active: boolean;
  nextDueDate: string | null;
  lastCompletedAt: string | null;
  checklistTemplate: string;
  equipment: EquipmentRef | null;
  assignedTechnician: TechnicianRef | null;
};

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

/** Overdue PM task — identical predicate on the dashboard KPI (count consistency). */
function isTaskOverdue(t: PmTask): boolean {
  return ["SCHEDULED", "IN_PROGRESS", "OVERDUE"].includes(t.status) && new Date(t.dueDate) < new Date();
}

/** Tasks-tab status filter options; values are the canonical drill-down params. */
const TASK_STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "active", label: "Active (open)" },
  { value: "overdue", label: "Overdue" },
  { value: "SCHEDULED", label: "Scheduled" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "SKIPPED", label: "Skipped" },
];

function matchTaskStatus(t: PmTask, v: string): boolean {
  if (v === "active") return ["SCHEDULED", "IN_PROGRESS", "OVERDUE"].includes(t.status);
  if (v === "overdue") return isTaskOverdue(t);
  return t.status === v;
}

// ── Module router ──

export function PmModule() {
  const seg = useUi((s) => s.pages["pm"]) ?? [];
  const query = useUi((s) => s.queries["pm"] ?? "");
  const page = pageFromSeg(seg);

  if (page.view === "new") return <PmNewPage />;
  if (page.view === "complete" && page.id) return <PmCompleteTaskPage id={page.id} />;
  // key={query}: a new drill-down URL (KPI click / direct link) remounts the
  // list with view=plans|tasks and the task status filter applied.
  return <PmList key={query} />;
}

// ── List page ──

function PmList() {
  const { user } = useSession();
  const { toast } = useToast();

  const canManage = hasPerm(user, PERMISSIONS.pm_manage);
  const canExecute = hasPerm(user, PERMISSIONS.pm_execute);
  const isTechnicianRole = user?.role === "TECHNICIAN";

  // ── Data ──
  const [plans, setPlans] = useState<PmPlan[]>([]);
  const [tasks, setTasks] = useState<PmTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // KPI drill-down: #/pm?view=tasks&status=overdue|active — validated below.
  const dq = useModuleQuery("pm");
  const viewParam = ["tasks", "plans"].find((v) => v === dq.params.view?.toLowerCase());
  const taskStatusParam = TASK_STATUS_FILTERS.find((f) => f.value === dq.params.status?.toLowerCase() || f.value === dq.params.status?.toUpperCase())?.value;
  const [tab, setTab] = useState(viewParam ?? "plans");

  const [generatingPlanId, setGeneratingPlanId] = useState<string | null>(null);
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  // Skip confirmation (AlertDialog — replaces the old window.confirm)
  const [skipTask, setSkipTask] = useState<PmTask | null>(null);
  const [skipping, setSkipping] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mineParam = isTechnicianRole && !canManage ? { mine: "1" } : {};
      const [plansRes, tasksRes] = await Promise.all([
        api.get<PmPlan[]>(`/api/v1/pm/plans${qs({ pageSize: "200" })}`),
        api.get<PmTask[]>(`/api/v1/pm/tasks${qs({ pageSize: "200", ...mineParam })}`),
      ]);
      setPlans(plansRes.data ?? []);
      setTasks(tasksRes.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load preventive maintenance data.");
    } finally {
      setLoading(false);
    }
  }, [canManage, isTechnicianRole]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Stats ──
  const stats = useMemo(() => {
    const now = new Date();
    const in7 = new Date(Date.now() + 7 * 86400000);
    return {
      activePlans: plans.filter((p) => p.active).length,
      dueThisWeek: plans.filter((p) => p.active && p.nextDueDate && new Date(p.nextDueDate) <= in7).length,
      overdue: tasks.filter((t) => t.status === "OVERDUE" || (["SCHEDULED", "IN_PROGRESS"].includes(t.status) && new Date(t.dueDate) < now)).length,
      completedThisMonth: tasks.filter((t) => {
        if (t.status !== "COMPLETED" || !t.completedAt) return false;
        const d = new Date(t.completedAt);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      }).length,
    };
  }, [plans, tasks]);

  // ── Plan actions (inline quick actions) ──
  const toggleActive = async (plan: PmPlan, active: boolean) => {
    try {
      await api.patch(`/api/v1/pm/plans/${plan.id}`, { active });
      setPlans((prev) => prev.map((p) => (p.id === plan.id ? { ...p, active } : p)));
      toast({ title: active ? "Plan activated" : "Plan deactivated", description: `${plan.code} — ${plan.name}.` });
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const generateForPlan = async (plan: PmPlan) => {
    setGeneratingPlanId(plan.id);
    try {
      const res = await api.post<PmTask>(`/api/v1/pm/plans/${plan.id}/generate`);
      toast({ title: "Task generated", description: `${res.data.code} scheduled for ${fmtDate(res.data.dueDate)}.` });
      await load();
    } catch (e) {
      toast({ title: "Generation failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setGeneratingPlanId(null);
    }
  };

  const generateDueTasks = async () => {
    const today = new Date();
    const due = plans.filter((p) => p.active && p.nextDueDate && new Date(p.nextDueDate) <= today);
    if (due.length === 0) {
      toast({ title: "No plans are due", description: "All active plans have a next due date in the future." });
      return;
    }
    setBulkGenerating(true);
    let ok = 0;
    let failed = 0;
    for (const plan of due) {
      try {
        await api.post(`/api/v1/pm/plans/${plan.id}/generate`);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBulkGenerating(false);
    toast({
      title: `Generated ${ok} task${ok === 1 ? "" : "s"}`,
      description: failed > 0 ? `${failed} plan${failed === 1 ? "" : "s"} could not be generated.` : "All due plans now have scheduled tasks.",
      variant: failed > 0 ? "destructive" : "default",
    });
    await load();
  };

  // ── Task actions ──
  const transition = async (task: PmTask, action: "start" | "skip", notes?: string) => {
    setBusyTaskId(task.id);
    try {
      await api.post(`/api/v1/pm/tasks/${task.id}/transition`, { action, notes });
      toast({ title: action === "start" ? "Task started" : "Task skipped", description: `${task.code} → ${action === "start" ? "In Progress" : "Skipped"}.` });
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyTaskId(null);
    }
  };

  const confirmSkip = async () => {
    if (!skipTask) return;
    setSkipping(true);
    await transition(skipTask, "skip");
    setSkipping(false);
    setSkipTask(null);
  };

  const isOverdue = (t: PmTask) => ["SCHEDULED", "IN_PROGRESS", "OVERDUE"].includes(t.status) && new Date(t.dueDate) < new Date();

  // ── Plan columns ──
  const planColumns: Column<PmPlan>[] = [
    { key: "code", header: "Code", value: (p) => p.code, className: "font-medium whitespace-nowrap" },
    { key: "name", header: "Plan", value: (p) => p.name },
    {
      key: "equipment", header: "Equipment", hideOnMobile: true,
      value: (p) => (p.equipment ? `${p.equipment.name} ${p.equipment.assetTag}` : ""),
      render: (p) => p.equipment ? (
        <span>
          {p.equipment.name} <span className="text-muted-foreground text-xs">({p.equipment.assetTag})</span>
        </span>
      ) : "—",
    },
    { key: "frequency", header: "Frequency", value: (p) => p.frequency, render: (p) => <StatusBadge status={p.frequency} /> },
    {
      key: "nextDueDate", header: "Next Due", value: (p) => p.nextDueDate ?? "", hideOnMobile: true,
      render: (p) => {
        const due = p.nextDueDate ? new Date(p.nextDueDate) : null;
        const isDue = p.active && due && due <= new Date();
        return <span className={isDue ? "text-red-600 font-medium" : ""}>{fmtDate(p.nextDueDate)}</span>;
      },
    },
    {
      key: "technician", header: "Technician", hideOnMobile: true,
      value: (p) => p.assignedTechnician?.user?.name ?? "",
      render: (p) => p.assignedTechnician?.user?.name ?? <span className="text-muted-foreground">—</span>,
    },
    ...(canManage
      ? [{
          key: "active", header: "Active", sortable: false,
          render: (p: PmPlan) => (
            <Switch
              checked={p.active}
              onCheckedChange={(v) => void toggleActive(p, v)}
              aria-label={`Toggle ${p.code}`}
            />
          ),
        } satisfies Column<PmPlan>]
      : []),
    ...(canManage || canExecute
      ? [{
          key: "actions", header: "", sortable: false,
          render: (p: PmPlan) => (
            <Button
              variant="outline" size="sm"
              disabled={!p.active || generatingPlanId === p.id || bulkGenerating}
              onClick={() => void generateForPlan(p)}
              aria-label={`Generate task for ${p.code}`}
            >
              <Zap className="h-3.5 w-3.5 mr-1" /> {generatingPlanId === p.id ? "Generating…" : "Generate"}
            </Button>
          ),
        } satisfies Column<PmPlan>]
      : []),
  ];

  // ── Task columns ──
  const taskColumns: Column<PmTask>[] = [
    { key: "code", header: "Code", value: (t) => t.code, className: "font-medium whitespace-nowrap" },
    { key: "plan", header: "Plan", value: (t) => t.plan?.name ?? "", render: (t) => t.plan?.name ?? "—" },
    {
      key: "equipment", header: "Equipment", hideOnMobile: true,
      value: (t) => (t.equipment ? `${t.equipment.name} ${t.equipment.assetTag}` : ""),
      render: (t) => t.equipment ? `${t.equipment.name} (${t.equipment.assetTag})` : "—",
    },
    {
      key: "dueDate", header: "Due", value: (t) => t.dueDate,
      render: (t) => (
        <span className={isOverdue(t) ? "text-red-600 font-medium" : ""}>{fmtDate(t.dueDate)}</span>
      ),
    },
    { key: "status", header: "Status", value: (t) => t.status, render: (t) => <StatusBadge status={t.status} /> },
    {
      key: "technician", header: "Technician", hideOnMobile: true,
      value: (t) => t.technician?.user?.name ?? "",
      render: (t) => t.technician?.user?.name ?? <span className="text-muted-foreground">Unassigned</span>,
    },
    ...(canManage || canExecute
      ? [{
          key: "taskActions", header: "Actions", sortable: false,
          render: (t: PmTask) => {
            const active = ["SCHEDULED", "OVERDUE", "IN_PROGRESS"].includes(t.status);
            if (!active) return <span className="text-xs text-muted-foreground">—</span>;
            return (
              <div className="flex items-center gap-1.5">
                {t.status !== "IN_PROGRESS" ? (
                  <Button
                    variant="outline" size="sm"
                    disabled={busyTaskId === t.id}
                    onClick={() => void transition(t, "start")}
                    aria-label={`Start ${t.code}`}
                  >
                    <Play className="h-3.5 w-3.5 mr-1" /> Start
                  </Button>
                ) : null}
                {/* Complete → dedicated full page (#/pm/{taskId}/complete) */}
                <Button
                  variant="outline" size="sm"
                  disabled={busyTaskId === t.id}
                  onClick={() => navigateTo("pm", [t.id, "complete"])}
                  aria-label={`Complete ${t.code}`}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Complete
                </Button>
                {canManage ? (
                  <Button
                    variant="ghost" size="sm"
                    disabled={busyTaskId === t.id}
                    onClick={() => setSkipTask(t)}
                    aria-label={`Skip ${t.code}`}
                  >
                    <CircleOff className="h-3.5 w-3.5 mr-1" /> Skip
                  </Button>
                ) : null}
              </div>
            );
          },
        } satisfies Column<PmTask>]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Preventive Maintenance"
        subtitle="Recurring equipment care: plans, schedules and task execution"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void generateDueTasks()} disabled={bulkGenerating || !canManage && !canExecute}>
              <RotateCw className={`h-4 w-4 mr-1.5 ${bulkGenerating ? "animate-spin" : ""}`} />
              {bulkGenerating ? "Generating…" : "Generate due tasks"}
            </Button>
            {canManage ? (
              <Button size="sm" onClick={() => navigateTo("pm", ["new"])}>
                <Plus className="h-4 w-4 mr-1.5" /> New Plan
              </Button>
            ) : null}
          </>
        }
      />

      <DrilldownChips
        chips={[
          ...(viewParam ? [{ key: "view", label: "View", value: humanize(viewParam) }] : []),
          ...(taskStatusParam ? [{ key: "status", label: "Task status", value: TASK_STATUS_FILTERS.find((f) => f.value === taskStatusParam)?.label ?? taskStatusParam }] : []),
        ]}
        onRemove={(key) => dq.apply({ [key]: undefined })}
        onClear={dq.clear}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard title="Active Plans" value={stats.activePlans} icon={<CalendarClock className="h-5 w-5" />} loading={loading} />
        <StatCard title="Due This Week" value={stats.dueThisWeek} icon={<CalendarCheck2 className="h-5 w-5" />} tone="warning" loading={loading} />
        <StatCard title="Overdue Tasks" value={stats.overdue} icon={<AlarmClock className="h-5 w-5" />} tone="danger" loading={loading} />
        <StatCard title="Completed This Month" value={stats.completedThisMonth} icon={<CheckCircle2 className="h-5 w-5" />} tone="success" loading={loading} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="plans"><CalendarClock className="h-4 w-4 mr-1.5" /> Plans</TabsTrigger>
          <TabsTrigger value="tasks"><ClipboardList className="h-4 w-4 mr-1.5" /> Tasks</TabsTrigger>
        </TabsList>

        <TabsContent value="plans">
          {loading ? (
            <LoadingState label="Loading plans…" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : plans.length === 0 ? (
            <EmptyState
              title="No PM plans yet"
              hint={canManage ? "Create a plan to schedule recurring maintenance for an equipment." : "No maintenance plans have been published yet."}
              action={canManage ? <Button size="sm" onClick={() => navigateTo("pm", ["new"])}><Plus className="h-4 w-4 mr-1.5" /> New Plan</Button> : undefined}
            />
          ) : (
            <DataTable
              columns={planColumns}
              rows={plans}
              rowKey={(p) => p.id}
              searchPlaceholder="Search code, plan, equipment…"
              emptyTitle="No plans match"
              exportName="pm-plans"
            />
          )}
        </TabsContent>

        <TabsContent value="tasks">
          {loading ? (
            <LoadingState label="Loading tasks…" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : tasks.length === 0 ? (
            <EmptyState
              title="No PM tasks"
              hint={canManage || canExecute ? "Use “Generate due tasks” or a plan's Generate action to schedule work." : "No maintenance tasks have been scheduled."}
            />
          ) : (
            <DataTable
              columns={taskColumns}
              rows={tasks}
              rowKey={(t) => t.id}
              searchPlaceholder="Search code, plan, equipment…"
              emptyTitle="No tasks match"
              exportName="pm-tasks"
              initialFilters={taskStatusParam ? { taskStatus: taskStatusParam } : undefined}
              filters={[{ key: "taskStatus", label: "Task status", options: TASK_STATUS_FILTERS, match: matchTaskStatus }]}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Skip confirmation — the only dialog left in this module */}
      <AlertDialog open={skipTask !== null} onOpenChange={(open) => { if (!open && !skipping) setSkipTask(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Skip this task?</AlertDialogTitle>
            <AlertDialogDescription>
              {skipTask ? `${skipTask.code}${skipTask.plan?.name ? ` — ${skipTask.plan.name}` : ""} will be marked SKIPPED. This cannot be undone; generate a new task from the plan if the work is still required.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={skipping}>Keep task</AlertDialogCancel>
            <AlertDialogAction
              disabled={skipping}
              onClick={(e) => { e.preventDefault(); void confirmSkip(); }}
            >
              {skipping ? "Skipping…" : "Skip task"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
