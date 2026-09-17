"use client";

// Preventive Maintenance module — plan register + task execution.
// Plans: create (draft-protected), activate/deactivate inline, generate tasks.
// Tasks: lifecycle actions (start / complete with checklist / skip), overdue highlighting.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock, CalendarCheck2, AlarmClock, CheckCircle2, Play, Flag, Zap,
  ClipboardList, RotateCw, Plus, CircleOff,
} from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate } from "@/lib/hms/format";
import { humanize, PERMISSIONS, PM_FREQUENCIES } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

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

type Option = { id: string; label: string };

const emptyPlanForm = {
  name: "",
  equipmentId: "",
  frequency: "MONTHLY",
  assignedTechnicianId: "",
  checklist: "",
  nextDueDate: "",
};

export function PmModule() {
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
  const [tab, setTab] = useState("plans");

  const [equipmentOptions, setEquipmentOptions] = useState<Option[] | null>(null);
  const [technicianOptions, setTechnicianOptions] = useState<Option[] | null>(null);

  const [generatingPlanId, setGeneratingPlanId] = useState<string | null>(null);
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  // ── Create plan dialog (draft-protected) ──
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const draft = useDraft({ formKey: "pm.plan.create", initial: emptyPlanForm });

  // ── Complete dialog ──
  const [completeTask, setCompleteTask] = useState<PmTask | null>(null);
  const [completeItems, setCompleteItems] = useState<ChecklistItem[]>([]);
  const [completeNotes, setCompleteNotes] = useState("");
  const [completing, setCompleting] = useState(false);

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

  // Reference data (equipment + technicians) — degrade gracefully when unavailable
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<EquipmentRef[]>(`/api/v1/equipment${qs({ pageSize: "200" })}`);
        setEquipmentOptions((res.data ?? []).map((e) => ({ id: e.id, label: `${e.name} (${e.assetTag})` })));
      } catch {
        setEquipmentOptions(null);
      }
    })();
    (async () => {
      try {
        const res = await api.get<TechnicianRef[]>(`/api/v1/technicians${qs({ pageSize: "200" })}`);
        setTechnicianOptions((res.data ?? []).map((t) => ({
          id: t.id,
          label: t.user?.name ? `${t.user.name} (${t.employeeNo})` : t.employeeNo,
        })));
      } catch {
        setTechnicianOptions(null);
      }
    })();
  }, []);

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

  // ── Plan actions ──
  const createPlan = async () => {
    if (!draft.value.name.trim()) {
      toast({ title: "Plan name is required", variant: "destructive" });
      return;
    }
    if (!draft.value.equipmentId) {
      toast({ title: "Select equipment for this plan", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const labels = draft.value.checklist.split("\n").map((l) => l.trim()).filter(Boolean);
      const res = await api.post<PmPlan>("/api/v1/pm/plans", {
        name: draft.value.name.trim(),
        equipmentId: draft.value.equipmentId,
        frequency: draft.value.frequency,
        assignedTechnicianId: draft.value.assignedTechnicianId || null,
        checklistTemplate: labels,
        nextDueDate: draft.value.nextDueDate || null,
      });
      draft.reset(emptyPlanForm);
      setCreateOpen(false);
      toast({ title: "PM plan created", description: `${res.data.code} — ${res.data.name}.` });
      await load();
    } catch (e) {
      toast({ title: "Could not create plan", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

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

  const openComplete = async (task: PmTask) => {
    setCompleteTask(task);
    setCompleteItems([]);
    setCompleteNotes("");
    try {
      const res = await api.get<PmTask>(`/api/v1/pm/tasks/${task.id}`);
      setCompleteItems(res.data.checklist ?? []);
      if (res.data.notes) setCompleteNotes(res.data.notes);
    } catch {
      setCompleteItems([]); // checklist failed to load — task can still be completed if no items
    }
  };

  const submitComplete = async () => {
    if (!completeTask) return;
    const allDone = completeItems.length === 0 || completeItems.every((i) => i.done);
    if (!allDone) {
      toast({ title: "Checklist incomplete", description: "Tick off every checklist item before completing.", variant: "destructive" });
      return;
    }
    setCompleting(true);
    try {
      await api.post(`/api/v1/pm/tasks/${completeTask.id}/transition`, {
        action: "complete",
        notes: completeNotes || undefined,
        checklist: completeItems.map((i) => ({ id: i.id, done: i.done })),
      });
      toast({ title: "PM completed", description: `${completeTask.code} marked as completed.` });
      setCompleteTask(null);
      await load();
    } catch (e) {
      toast({ title: "Could not complete task", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setCompleting(false);
    }
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
                <Button
                  variant="outline" size="sm"
                  disabled={busyTaskId === t.id}
                  onClick={() => void openComplete(t)}
                  aria-label={`Complete ${t.code}`}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Complete
                </Button>
                {canManage ? (
                  <Button
                    variant="ghost" size="sm"
                    disabled={busyTaskId === t.id}
                    onClick={() => {
                      if (window.confirm(`Skip ${t.code}? The task will be marked SKIPPED.`)) void transition(t, "skip");
                    }}
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
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" /> New Plan
              </Button>
            ) : null}
          </>
        }
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
              action={canManage ? <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> New Plan</Button> : undefined}
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
            />
          )}
        </TabsContent>
      </Tabs>

      {/* ── New Plan dialog ── */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open && draft.dirty) { /* draft persists for restore */ } setCreateOpen(open); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto hms-scroll">
          <DialogHeader>
            <DialogTitle>New PM Plan</DialogTitle>
            <DialogDescription>
              Schedule recurring maintenance. Your draft is auto-saved if you step away.
              {draft.draftExists ? (
                <button type="button" className="ml-1 underline underline-offset-2 text-primary" onClick={draft.restore}>
                  Restore saved draft
                </button>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pm-plan-name">Plan Name *</Label>
              <Input
                id="pm-plan-name"
                value={draft.value.name}
                onChange={(e) => draft.setValue({ name: e.target.value })}
                placeholder="Monthly HVAC filter service"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Equipment *</Label>
              <Select value={draft.value.equipmentId || undefined} onValueChange={(v) => draft.setValue({ equipmentId: v })}>
                <SelectTrigger aria-label="Equipment"><SelectValue placeholder={equipmentOptions === null ? "Equipment list unavailable" : "Select equipment"} /></SelectTrigger>
                <SelectContent>
                  {(equipmentOptions ?? []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {equipmentOptions === null ? <p className="text-xs text-amber-600">Equipment list could not be loaded. Try refreshing the page.</p> : null}
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
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pm-plan-checklist">Checklist Labels (one per line)</Label>
              <Textarea
                id="pm-plan-checklist"
                rows={5}
                value={draft.value.checklist}
                onChange={(e) => draft.setValue({ checklist: e.target.value })}
                placeholder={"Inspect air filter\nCheck refrigerant pressure\nTest thermostat"}
              />
            </div>
          </div>

          <DialogFooter>
            <div className="flex w-full items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {draft.dirty ? "Draft auto-saved" : "All changes saved"}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>Cancel</Button>
                <Button onClick={() => void createPlan()} disabled={saving}>
                  {saving ? "Creating…" : "Create Plan"}
                </Button>
              </div>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Complete dialog (checklist) ── */}
      <Dialog open={completeTask !== null} onOpenChange={(open) => { if (!open) setCompleteTask(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto hms-scroll">
          <DialogHeader>
            <DialogTitle>Complete {completeTask?.code}</DialogTitle>
            <DialogDescription>
              {completeTask?.plan?.name} — {completeTask?.equipment?.name}. Tick every checklist item, add notes, then complete.
            </DialogDescription>
          </DialogHeader>

          {completeTask ? (
            <div className="space-y-3 py-2">
              <div className="text-sm text-muted-foreground">
                Due <span className="font-medium text-foreground">{fmtDate(completeTask.dueDate)}</span>
                {completeTask.status === "OVERDUE" ? <span className="text-red-600 font-medium"> · overdue</span> : null}
              </div>

              {completeItems.length > 0 ? (
                <div className="space-y-2">
                  <Label>Checklist ({completeItems.filter((i) => i.done).length}/{completeItems.length} done)</Label>
                  {completeItems.map((item) => (
                    <label
                      key={item.id}
                      className="flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer hover:bg-muted/50"
                    >
                      <Switch
                        checked={item.done}
                        onCheckedChange={(v) => setCompleteItems((items) => items.map((i) => (i.id === item.id ? { ...i, done: v } : i)))}
                        aria-label={item.label}
                      />
                      <span className={`text-sm ${item.done ? "line-through text-muted-foreground" : ""}`}>{item.label}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">This task has no checklist items.</p>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="pm-complete-notes">Notes</Label>
                <Textarea
                  id="pm-complete-notes"
                  rows={3}
                  value={completeNotes}
                  onChange={(e) => setCompleteNotes(e.target.value)}
                  placeholder="Observations, parts replaced, follow-ups…"
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleteTask(null)} disabled={completing}>Cancel</Button>
            <Button
              onClick={() => void submitComplete()}
              disabled={completing || !(completeItems.length === 0 || completeItems.every((i) => i.done))}
              title={completeItems.some((i) => !i.done) ? "Complete every checklist item first" : undefined}
            >
              <Flag className="h-4 w-4 mr-1.5" /> {completing ? "Completing…" : "Complete Task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
