"use client";

// MOHD.HMS ENTERPRISE — PM Plans tab: plan register table.
// Columns: code, plan, equipment, customer, type, frequency description,
// priority, next due (red when past), last completed, technician, active.
// Actions: View (dedicated page), Generate occurrence (idempotent API →
// navigates to the task), Activate/Deactivate. "New PM Plan" gated pm_manage.

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { navigateTo } from "@/lib/hms/router";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS, humanize, PM_PLAN_TYPES } from "@/lib/hms/constants";
import { customerLabel, fmtDate } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, PriorityBadge, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CalendarClock, Eye, Plus, Zap } from "lucide-react";
import { frequencyDescription, type PmPlanRow } from "./pm-shared";

export function PmPlansTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.pm_manage);
  const canGenerate = canManage || hasPerm(user, PERMISSIONS.pm_execute);

  const [plans, setPlans] = useState<PmPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<PmPlanRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<PmPlanRow[]>(`/api/v1/pm/plans${qs({ pageSize: "200" })}`);
      setPlans(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load PM plans.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.pm, () => { void load(); });

  const toggleActive = async (plan: PmPlanRow, active: boolean) => {
    setBusyPlanId(plan.id);
    try {
      await api.patch(`/api/v1/pm/plans/${plan.id}`, { active });
      setPlans((prev) => prev.map((p) => (p.id === plan.id ? { ...p, active } : p)));
      toast({ title: active ? "Plan activated" : "Plan deactivated", description: `${plan.code} — ${plan.name}.` });
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyPlanId(null);
      setConfirmDeactivate(null);
    }
  };

  const generate = async (plan: PmPlanRow) => {
    setBusyPlanId(plan.id);
    try {
      const res = await api.post<
        | { duplicate: false; task: { id: string; code: string; dueDate: string }; workOrderId: string; workOrderCode: string }
        | { duplicate: true; taskId: string | null; taskCode: string | null }
      >(`/api/v1/pm/plans/${plan.id}/generate`);
      if (res.data.duplicate) {
        toast({ title: "Occurrence already open", description: res.data.taskCode ? `${res.data.taskCode} is the current open occurrence.` : "An open occurrence already exists for this plan." });
        if (res.data.taskId) navigateTo("pm", ["tasks", res.data.taskId]);
      } else {
        toast({ title: "Task generated", description: `${res.data.task.code} scheduled for ${fmtDate(res.data.task.dueDate)} (WO ${res.data.workOrderCode}).` });
        navigateTo("pm", ["tasks", res.data.task.id]);
      }
      await load();
    } catch (e) {
      toast({ title: "Generation failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyPlanId(null);
    }
  };

  const columns: Column<PmPlanRow>[] = [
    { key: "code", header: "Code", value: (p) => p.code, className: "font-mono text-xs whitespace-nowrap" },
    {
      key: "name", header: "Plan", value: (p) => p.name,
      render: (p) => (
        <button type="button" onClick={() => navigateTo("pm", ["plans", p.id])} className="font-medium text-left hover:underline underline-offset-2 min-h-[44px]">
          {p.name}
        </button>
      ),
    },
    {
      key: "equipment", header: "Equipment", hideOnMobile: true, value: (p) => (p.equipment ? `${p.equipment.name} ${p.equipment.assetTag}` : ""),
      render: (p) => p.equipment ? (
        <span className="text-sm">{p.equipment.name} <span className="text-muted-foreground text-xs">({p.equipment.assetTag})</span></span>
      ) : "—",
    },
    { key: "customer", header: "Customer", hideOnMobile: true, value: (p) => customerLabel(p.equipment?.customer), render: (p) => customerLabel(p.equipment?.customer) },
    { key: "planType", header: "Type", hideOnMobile: true, value: (p) => p.planType, render: (p) => <StatusBadge status={p.planType} /> },
    {
      key: "frequency", header: "Frequency", hideOnMobile: true, value: (p) => frequencyDescription(p),
      render: (p) => <span className="text-sm whitespace-nowrap">{frequencyDescription(p)}</span>,
    },
    { key: "priority", header: "Priority", value: (p) => p.priority ?? "", render: (p) => <PriorityBadge priority={p.priority} /> },
    {
      key: "nextDueDate", header: "Next Due", value: (p) => p.nextDueDate ?? "",
      render: (p) => {
        const past = p.active && p.nextDueDate && new Date(p.nextDueDate) <= new Date();
        return <span className={`whitespace-nowrap text-sm ${past ? "text-red-600 font-medium" : ""}`}>{fmtDate(p.nextDueDate)}</span>;
      },
    },
    {
      key: "lastCompletedAt", header: "Last Done", hideOnMobile: true, value: (p) => p.lastCompletedAt ?? "",
      render: (p) => <span className="whitespace-nowrap text-sm text-muted-foreground">{fmtDate(p.lastCompletedAt)}</span>,
    },
    {
      key: "technician", header: "Technician", hideOnMobile: true, value: (p) => p.assignedTechnician?.user?.name ?? "",
      render: (p) => p.assignedTechnician?.user?.name ?? <span className="text-muted-foreground text-sm">Unassigned</span>,
    },
    {
      key: "active", header: "Active", value: (p) => (p.active ? "Active" : "Inactive"),
      render: (p) => <Badge variant="outline" className={`whitespace-nowrap border-transparent ${p.active ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"}`}>{p.active ? "Active" : "Inactive"}</Badge>,
    },
    ...(canManage
      ? [{
          key: "activeSwitch", header: "", sortable: false, hideOnMobile: true,
          render: (p: PmPlanRow) => (
            <Switch
              checked={p.active}
              disabled={busyPlanId === p.id}
              onCheckedChange={(v) => { if (!v) setConfirmDeactivate(p); else void toggleActive(p, true); }}
              aria-label={`Toggle ${p.code} active`}
            />
          ),
        } satisfies Column<PmPlanRow>]
      : []),
    {
      key: "actions", header: "", sortable: false,
      render: (p) => (
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => navigateTo("pm", ["plans", p.id])} aria-label={`View plan ${p.code}`}>
            <Eye className="h-3.5 w-3.5" />
            <span className="sr-only sm:not-sr-only sm:ml-1">View</span>
          </Button>
          {canGenerate ? (
            <Button
              variant="outline" size="sm" className="min-h-[44px]"
              disabled={!p.active || busyPlanId === p.id}
              onClick={() => void generate(p)}
              aria-label={`Generate occurrence for ${p.code}`}
            >
              <Zap className={`h-3.5 w-3.5 ${busyPlanId === p.id ? "animate-pulse" : ""}`} />
              <span className="sr-only sm:not-sr-only sm:ml-1">{busyPlanId === p.id ? "Generating…" : "Generate"}</span>
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="PM Plans"
        subtitle="Recurring maintenance programmes per asset — calendar and meter driven"
        actions={canManage ? (
          <Button size="sm" onClick={() => navigateTo("pm", ["new"])}>
            <Plus className="h-4 w-4 mr-1.5" /> New PM Plan
          </Button>
        ) : null}
      />

      {loading ? (
        <LoadingState label="Loading plans…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : plans.length === 0 ? (
        <EmptyState
          title="No PM plans yet"
          hint={canManage
            ? "Create a plan to schedule recurring maintenance for an equipment — calendar cadence or meter threshold."
            : "No maintenance plans have been published yet."}
          action={canManage ? (
            <Button size="sm" onClick={() => navigateTo("pm", ["new"])}>
              <CalendarClock className="h-4 w-4 mr-1.5" /> New PM Plan
            </Button>
          ) : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={plans}
          rowKey={(p) => p.id}
          searchPlaceholder="Search code, plan, equipment…"
          emptyTitle="No plans match"
          exportName="pm-plans"
          filters={[
            {
              key: "planType", label: "Types",
              options: PM_PLAN_TYPES.map((t) => ({ value: t, label: humanize(t) })),
              match: (row, value) => row.planType === value,
            },
            {
              key: "active", label: "Status",
              options: [{ value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }],
              match: (row, value) => (value === "ACTIVE" ? row.active : !row.active),
            },
          ]}
        />
      )}

      <AlertDialog open={confirmDeactivate !== null} onOpenChange={(open) => { if (!open) setConfirmDeactivate(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate this plan?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeactivate
                ? `${confirmDeactivate.code} — ${confirmDeactivate.name} will stop generating new occurrences. Task history is preserved and the plan can be re-activated at any time.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep active</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); if (confirmDeactivate) void toggleActive(confirmDeactivate, false); }}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
