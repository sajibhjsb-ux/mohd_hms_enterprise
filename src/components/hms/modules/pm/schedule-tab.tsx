"use client";

// MOHD.HMS ENTERPRISE — PM Schedule tab: occurrence worklist.
// Filter chips (All · Due today · Due this week · Due this month · Overdue ·
// My PM) + status/priority selects — all synced to the module URL query so KPI
// drill-downs, Back/Forward and deep links work. Desktop DataTable; mobile
// card list with ≥44px actions; technician view (mine=1) groups into
// Today / Overdue / Upcoming sections computed client-side.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { navigateTo } from "@/lib/hms/router";
import { useModuleQuery } from "@/lib/hms/page-query";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS, humanize, PM_PRIORITIES, PM_TASK_STATUSES } from "@/lib/hms/constants";
import { customerLabel, fmtDate } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, PriorityBadge, StatusBadge, DrilldownChips,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarClock, CalendarDays, CircleOff, ClipboardList, Eye, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { daysOverdue, isTaskOpen, type PmTaskRow } from "./pm-shared";

const CHIP_FILTERS = [
  { key: "all", label: "All" },
  { key: "today", label: "Due today", params: { due: "today" } },
  { key: "week", label: "Due this week", params: { due: "week" } },
  { key: "month", label: "Due this month", params: { due: "month" } },
  { key: "overdue", label: "Overdue", params: { overdue: "1" } },
  { key: "mine", label: "My PM", params: { mine: "1" } },
] as const;

function activeChip(params: Record<string, string>): string {
  if (params.overdue === "1") return "overdue";
  if (params.mine === "1") return "mine";
  if (params.due === "today") return "today";
  if (params.due === "week") return "week";
  if (params.due === "month") return "month";
  return "all";
}

export function PmScheduleTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const isTechnicianRole = user?.role === "TECHNICIAN";
  const canExecute = hasPerm(user, PERMISSIONS.pm_execute) || hasPerm(user, PERMISSIONS.pm_manage);

  // URL query state — canonical source is the module query store (shell-synced).
  const dq = useModuleQuery("pm");
  const params = dq.params;

  const applyParams = useCallback((next: Record<string, string | undefined>) => {
    dq.apply({ ...next, tab: "schedule" });
  }, [dq]);

  // Server fetch driven by the query params.
  const [tasks, setTasks] = useState<PmTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mineParam = isTechnicianRole && !params.mine ? { mine: "1" } : {};
      const res = await api.get<PmTaskRow[]>(`/api/v1/pm/tasks${qs({
        pageSize: "200",
        status: params.status,
        due: params.due,
        overdue: params.overdue,
        mine: params.mine,
        priority: params.priority,
        ...mineParam,
      })}`);
      setTasks(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load the PM schedule.");
    } finally {
      setLoading(false);
    }
  }, [params, isTechnicianRole]);

  useEffect(() => { load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.pm, () => { void load(); });

  /** Quick start: linked occurrences run through the canonical WO API (§22). */
  const quickStart = async (t: PmTaskRow) => {
    setBusyTaskId(t.id);
    try {
      if (t.workOrder?.id) {
        const woStatus = t.workOrder.status;
        if (woStatus === "PENDING") {
          await api.post(`/api/v1/work-orders/${t.workOrder.id}/transition`, { action: "accept" });
        }
        if (woStatus === "PENDING" || woStatus === "ACCEPTED") {
          await api.post(`/api/v1/work-orders/${t.workOrder.id}/transition`, { action: "start" });
        }
        toast({ title: "Work started", description: `${t.code} — execution work order ${t.workOrder.code} is now in progress.` });
      } else {
        await api.post(`/api/v1/pm/tasks/${t.id}/transition`, { action: "start" });
        toast({ title: "Task started", description: `${t.code} is now in progress.` });
      }
      await load();
    } catch (e) {
      toast({ title: "Could not start", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyTaskId(null);
    }
  };

  const chip = activeChip(params);
  const mineView = params.mine === "1";

  const columns: Column<PmTaskRow>[] = [
    { key: "code", header: "Code", value: (t) => t.code, className: "font-mono text-xs whitespace-nowrap" },
    { key: "plan", header: "Plan", value: (t) => t.plan?.name ?? "", render: (t) => t.plan?.name ?? "—" },
    {
      key: "equipment", header: "Equipment", hideOnMobile: true,
      value: (t) => (t.equipment ? `${t.equipment.name} ${t.equipment.assetTag}` : ""),
      render: (t) => t.equipment ? `${t.equipment.name} (${t.equipment.assetTag})` : "—",
    },
    { key: "customer", header: "Customer", hideOnMobile: true, value: (t) => customerLabel(t.equipment?.customer), render: (t) => customerLabel(t.equipment?.customer) },
    { key: "location", header: "Location", hideOnMobile: true, value: (t) => t.equipment?.location?.name ?? "", render: (t) => t.equipment?.location?.name ?? "—" },
    {
      key: "dueDate", header: "Due", value: (t) => t.dueDate,
      render: (t) => {
        const od = isTaskOpen(t.status) ? daysOverdue(t.dueDate) : 0;
        return (
          <span className={cn("whitespace-nowrap text-sm", od > 0 && "text-red-600 font-medium")}>
            {fmtDate(t.dueDate)}
            {od > 0 ? <span className="ml-1 text-xs">({od}d late)</span> : null}
          </span>
        );
      },
    },
    { key: "priority", header: "Priority", value: (t) => t.priority ?? "", render: (t) => <PriorityBadge priority={t.priority} /> },
    { key: "status", header: "Status", value: (t) => t.status, render: (t) => <StatusBadge status={t.status} /> },
    {
      key: "wo", header: "Work Order", hideOnMobile: true,
      value: (t) => t.workOrder?.code ?? "",
      render: (t) => t.workOrder ? (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <button type="button" onClick={(e) => { e.stopPropagation(); navigateTo("work-orders", [t.workOrder!.id]); }} className="font-mono text-xs text-primary hover:underline">
            {t.workOrder.code}
          </button>
          <StatusBadge status={t.workOrder.status} />
        </span>
      ) : <span className="text-xs text-muted-foreground">—</span>,
    },
    {
      key: "technician", header: "Technician", hideOnMobile: true,
      value: (t) => t.technician?.user?.name ?? "",
      render: (t) => t.technician?.user?.name ?? <span className="text-muted-foreground text-sm">Unassigned</span>,
    },
    {
      key: "actions", header: "", sortable: false,
      render: (t) => (
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => navigateTo("pm", ["tasks", t.id])} aria-label={`Open ${t.code}`}>
            <Eye className="h-3.5 w-3.5" />
            <span className="sr-only sm:not-sr-only sm:ml-1">Open</span>
          </Button>
          {canExecute && isTaskOpen(t.status) && t.status !== "IN_PROGRESS" ? (
            <Button variant="outline" size="sm" className="min-h-[44px]" disabled={busyTaskId === t.id} onClick={() => void quickStart(t)} aria-label={`Start ${t.code}`}>
              <Play className="h-3.5 w-3.5" />
              <span className="sr-only sm:not-sr-only sm:ml-1">Start</span>
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  // Technician grouped view (mine=1): Today / Overdue / Upcoming.
  const groups = useMemo(() => {
    const open = tasks.filter((t) => isTaskOpen(t.status));
    const todayKey = new Date().toDateString();
    const inToday = open.filter((t) => new Date(t.dueDate).toDateString() === todayKey || (isTaskOpen(t.status) && daysOverdue(t.dueDate) === 0 && new Date(t.dueDate) < new Date()));
    const overdue = open.filter((t) => daysOverdue(t.dueDate) > 0 && !inToday.includes(t));
    const upcoming = open.filter((t) => !inToday.includes(t) && !overdue.includes(t));
    return [
      { key: "today", title: "Today", icon: <CalendarDays className="h-4 w-4 text-primary" />, items: inToday },
      { key: "overdue", title: "Overdue", icon: <CircleOff className="h-4 w-4 text-red-600" />, items: overdue },
      { key: "upcoming", title: "Upcoming", icon: <CalendarClock className="h-4 w-4 text-muted-foreground" />, items: upcoming },
    ].filter((g) => g.items.length > 0);
  }, [tasks]);

  return (
    <div>
      <PageHeader
        title="PM Schedule"
        subtitle="Occurrence worklist — today, this week, this month and what slipped"
      />

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3" role="group" aria-label="Schedule filters">
        {CHIP_FILTERS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => applyParams(c.key === "all" ? { due: undefined, overdue: undefined, mine: undefined } : c.params)}
            className={cn(
              "px-3 py-2 min-h-[44px] rounded-full text-xs font-medium border transition-colors",
              chip === c.key ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted text-muted-foreground"
            )}
            aria-pressed={chip === c.key}
          >
            {c.label}
          </button>
        ))}
        <div className="flex items-center gap-2 ml-auto">
          <Select value={params.status ?? "ALL"} onValueChange={(v) => applyParams({ status: v === "ALL" ? undefined : v })}>
            <SelectTrigger className="w-[150px] min-h-[44px]" aria-label="Status filter"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {PM_TASK_STATUSES.map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={params.priority ?? "ALL"} onValueChange={(v) => applyParams({ priority: v === "ALL" ? undefined : v })}>
            <SelectTrigger className="w-[140px] min-h-[44px]" aria-label="Priority filter"><SelectValue placeholder="All priorities" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All priorities</SelectItem>
              {PM_PRIORITIES.map((p) => <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DrilldownChips
        chips={[
          ...(params.due ? [{ key: "due", label: "Due", value: humanize(params.due === "week" ? "THIS_WEEK" : params.due === "month" ? "THIS_MONTH" : "TODAY") }] : []),
          ...(params.overdue === "1" ? [{ key: "overdue", label: "Window", value: "Overdue" }] : []),
          ...(params.mine === "1" ? [{ key: "mine", label: "Scope", value: "My PM" }] : []),
          ...(params.status ? [{ key: "status", label: "Status", value: humanize(params.status) }] : []),
          ...(params.priority ? [{ key: "priority", label: "Priority", value: humanize(params.priority) }] : []),
        ]}
        onRemove={(key) => applyParams({ [key]: undefined })}
        onClear={() => applyParams({ due: undefined, overdue: undefined, mine: undefined, status: undefined, priority: undefined })}
      />

      {loading ? (
        <LoadingState label="Loading occurrences…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : tasks.length === 0 ? (
        <EmptyState
          title="No occurrences match"
          hint={chip !== "all" ? "Try clearing the filters — or generate occurrences from an active plan." : "Generate occurrences from an active plan to schedule work."}
          action={<Button variant="outline" size="sm" onClick={() => navigateTo("pm", [], { tab: "plans" })}><ClipboardList className="h-4 w-4 mr-1.5" /> Go to plans</Button>}
        />
      ) : mineView ? (
        /* Technician grouped view */
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.title}>
              <h3 className="flex items-center gap-2 text-sm font-semibold mb-2">
                {g.icon} {g.title}
                <span className="text-muted-foreground font-normal tabular-nums">({g.items.length})</span>
              </h3>
              <div className="grid gap-2 md:grid-cols-2">
                {g.items.map((t) => (
                  <TaskCard key={t.id} t={t} onOpen={() => navigateTo("pm", ["tasks", t.id])} onStart={canExecute && t.status !== "IN_PROGRESS" ? () => void quickStart(t) : undefined} busy={busyTaskId === t.id} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block">
            <DataTable
              columns={columns}
              rows={tasks}
              rowKey={(t) => t.id}
              onRowClick={(t) => navigateTo("pm", ["tasks", t.id])}
              searchPlaceholder="Search code, plan, equipment, WO…"
              emptyTitle="No occurrences match"
              exportName="pm-schedule"
            />
          </div>
          {/* Mobile cards */}
          <div className="sm:hidden grid gap-2">
            {tasks.map((t) => (
              <TaskCard key={t.id} t={t} onOpen={() => navigateTo("pm", ["tasks", t.id])} onStart={canExecute && t.status !== "IN_PROGRESS" ? () => void quickStart(t) : undefined} busy={busyTaskId === t.id} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TaskCard({ t, onOpen, onStart, busy }: {
  t: PmTaskRow; onOpen: () => void; onStart?: () => void; busy?: boolean;
}) {
  const od = isTaskOpen(t.status) ? daysOverdue(t.dueDate) : 0;
  return (
    <div className="rounded-xl border bg-card p-3 space-y-2">
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-2 text-left min-h-[44px]">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{t.plan?.name ?? "—"}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {t.code} · {t.equipment ? `${t.equipment.name} (${t.equipment.assetTag})` : "—"}
          </span>
        </span>
        <PriorityBadge priority={t.priority} />
      </button>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className={cn("whitespace-nowrap", od > 0 ? "text-red-600 font-medium" : "text-muted-foreground")}>
          {fmtDate(t.dueDate)}{od > 0 ? ` · ${od}d late` : ""}
        </span>
        <StatusBadge status={t.status} />
        {t.workOrder ? <StatusBadge status={t.workOrder.status} /> : null}
        {t.technician?.user?.name ? <span className="text-muted-foreground truncate">{t.technician.user.name}</span> : null}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button variant="outline" size="sm" className="flex-1 min-h-[44px]" onClick={onOpen}>
          <Eye className="h-4 w-4 mr-1.5" /> Open
        </Button>
        {onStart ? (
          <Button variant="outline" size="sm" className="flex-1 min-h-[44px]" disabled={busy} onClick={onStart}>
            <Play className="h-4 w-4 mr-1.5" /> {busy ? "Starting…" : "Start"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
