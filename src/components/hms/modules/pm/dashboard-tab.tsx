"use client";

// MOHD.HMS ENTERPRISE — PM Dashboard tab (§55).
// 11 KPI cards + compliance% / completion% (formula tooltip), drill-down
// panels for high-risk assets and equipment without a plan, upcoming
// occurrences list. Every number is server-computed (GET /api/v1/pm/dashboard)
// — the client never invents data. Realtime refresh on PM events.

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { navigateTo } from "@/lib/hms/router";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate, fmtDateTime } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, PriorityBadge, StatCard, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlarmClock, CalendarCheck2, CalendarClock, CalendarDays, CheckCircle2, ClipboardList,
  Gauge, ListChecks, PlayCircle, ShieldAlert, XCircle, Zap,
} from "lucide-react";
import { daysOverdue, isTaskOpen } from "./pm-shared";

type EquipmentLite = { id: string; name: string; assetTag: string; criticality?: string | null };

type DashboardPayload = {
  kpis: {
    dueToday: number; dueThisWeek: number; dueThisMonth: number; overdue: number;
    scheduled: number; inProgress: number; completedThisMonth: number; failed: number;
    highRiskAssets: number; assetsWithoutPlan: number; openPmWorkOrders: number;
  };
  compliancePct: number | null;
  completionPct: number | null;
  compliance: { windowDays: number; dueOccurrences: number; completedOnTime: number; excluded: number; graceDays: number };
  upcoming: {
    id: string; code: string; dueDate: string; status: string; priority: string | null;
    plan: { name: string; code: string } | null;
    equipment: { name: string; assetTag: string; criticality: string | null } | null;
    technicianName: string | null;
  }[];
  generatedAt: string;
};

export function PmDashboard() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.pm_manage);

  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"high-risk" | "no-plan" | null>(null);
  const [panelItems, setPanelItems] = useState<EquipmentLite[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<DashboardPayload>("/api/v1/pm/dashboard");
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load the PM dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.pm, () => { void load(); });

  const openPanel = useCallback(async (which: Exclude<typeof panel, null>) => {
    if (panel === which) { setPanel(null); return; }
    setPanel(which);
    setPanelLoading(true);
    setPanelItems([]);
    try {
      if (which === "high-risk") {
        // High/critical active assets — the authoritative roster, filtered here
        // (the equipment list API has no criticality filter in the contract).
        const res = await api.get<EquipmentLite[]>(`/api/v1/equipment${qs({ status: "ACTIVE", pageSize: "200" })}`);
        setPanelItems((res.data ?? []).filter((e) => e.criticality === "HIGH" || e.criticality === "CRITICAL"));
      } else {
        // Active assets minus every asset referenced by an active plan.
        const [eqRes, planRes] = await Promise.all([
          api.get<EquipmentLite[]>(`/api/v1/equipment${qs({ status: "ACTIVE", pageSize: "200" })}`),
          api.get<{ equipment: { id: string } | null }[]>(`/api/v1/pm/plans${qs({ active: "1", pageSize: "200" })}`),
        ]);
        const withPlan = new Set((planRes.data ?? []).map((p) => p.equipment?.id).filter(Boolean));
        setPanelItems((eqRes.data ?? []).filter((e) => !withPlan.has(e.id)));
      }
    } catch (e) {
      toast({ title: "Could not load the drill-down panel", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      setPanel(null);
    } finally {
      setPanelLoading(false);
    }
  }, [panel, toast]);

  const k = data?.kpis;
  const compliance = data?.compliance;

  return (
    <div>
      <PageHeader
        title="Preventive Maintenance"
        subtitle="Compliance cockpit for recurring equipment care — server-computed KPIs, live updates"
        actions={
          <Button variant="outline" size="sm" onClick={() => navigateTo("pm", [], { tab: "schedule" })}>
            <ClipboardList className="h-4 w-4 mr-1.5" /> Open schedule
          </Button>
        }
      />

      {loading && !data ? (
        <LoadingState label="Loading PM dashboard…" rows={5} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data || !k ? (
        <EmptyState title="Dashboard unavailable" hint="The PM dashboard service did not return data." />
      ) : (
        <div className="space-y-5">
          {/* KPI grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
            <StatCard title="Due Today" value={k.dueToday} icon={<CalendarDays className="h-5 w-5" />} loading={loading} href="/pm?tab=schedule&due=today" />
            <StatCard title="Due This Week" value={k.dueThisWeek} icon={<CalendarCheck2 className="h-5 w-5" />} tone="warning" loading={loading} href="/pm?tab=schedule&due=week" />
            <StatCard title="Due This Month" value={k.dueThisMonth} icon={<CalendarClock className="h-5 w-5" />} loading={loading} href="/pm?tab=schedule&due=month" />
            <StatCard title="Overdue" value={k.overdue} icon={<AlarmClock className="h-5 w-5" />} tone="danger" loading={loading} href="/pm?tab=schedule&overdue=1" />
            <StatCard title="Scheduled" value={k.scheduled} icon={<CalendarCheck2 className="h-5 w-5" />} loading={loading} href="/pm?tab=schedule&status=SCHEDULED" />
            <StatCard title="In Progress" value={k.inProgress} icon={<PlayCircle className="h-5 w-5" />} tone="warning" loading={loading} href="/pm?tab=schedule&status=IN_PROGRESS" />
            <StatCard title="Completed This Month" value={k.completedThisMonth} icon={<CheckCircle2 className="h-5 w-5" />} tone="success" loading={loading} href="/pm?tab=schedule&status=COMPLETED" />
            <StatCard title="Failed" value={k.failed} icon={<XCircle className="h-5 w-5" />} tone="danger" loading={loading} href="/pm?tab=schedule&status=FAILED" />
            <StatCard
              title="High-Risk Assets" value={k.highRiskAssets} icon={<ShieldAlert className="h-5 w-5" />} tone="danger" loading={loading}
              sub="HIGH / CRITICAL criticality" onClick={() => void openPanel("high-risk")}
            />
            <StatCard
              title="Assets Without Plan" value={k.assetsWithoutPlan} icon={<ListChecks className="h-5 w-5" />} tone="warning" loading={loading}
              sub="Active equipment, no active plan" onClick={() => void openPanel("no-plan")}
            />
            <StatCard
              title="Open PM Work Orders" value={k.openPmWorkOrders} icon={<ClipboardList className="h-5 w-5" />} loading={loading}
              sub="Source: preventive maintenance" onClick={() => navigateTo("work-orders", [], { source: "pm" })}
            />
            <div className="grid gap-3">
              <PctCard
                title="Compliance" pct={data.compliancePct} loading={loading}
                formula="Completed on time ÷ due occurrences within the window (skipped/cancelled excluded)."
                detail={compliance
                  ? `${compliance.completedOnTime}/${compliance.dueOccurrences} on time · ${compliance.excluded} excluded · ${compliance.windowDays}-day window${compliance.graceDays ? ` · ${compliance.graceDays}d grace` : ""}`
                  : undefined}
              />
              <PctCard
                title="Completion" pct={data.completionPct} tone="success" loading={loading}
                formula="Completed occurrences ÷ due occurrences within the window — on time or late."
              />
            </div>
          </div>

          {/* Drill-down panels */}
          {panel ? (
            <Card className="shadow-sm">
              <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-base">
                  {panel === "high-risk" ? "High-risk assets" : "Assets without a PM plan"}
                  {panelLoading ? "" : ` (${panelItems.length})`}
                </CardTitle>
                <div className="flex items-center gap-2">
                  {panel === "no-plan" && canManage && panelItems.length > 0 ? (
                    <Button size="sm" onClick={() => navigateTo("pm", ["new"])}>
                      <Zap className="h-4 w-4 mr-1.5" /> Create a plan
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => setPanel(null)}>Hide</Button>
                </div>
              </CardHeader>
              <CardContent>
                {panelLoading ? (
                  <LoadingState label="Loading equipment…" rows={2} />
                ) : panelItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {panel === "high-risk" ? "No active HIGH/CRITICAL equipment found." : "Every active asset already has at least one active plan."}
                  </p>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto hms-scroll">
                    {panelItems.map((e) => (
                      <a key={e.id} href={`/equipment/${encodeURIComponent(e.id)}`} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 min-h-[44px] hover:bg-accent/60 transition-colors">
                        <span className="min-w-0 truncate text-sm font-medium">
                          {e.name} <span className="text-muted-foreground text-xs">({e.assetTag})</span>
                        </span>
                        {e.criticality ? <PriorityBadge priority={e.criticality} /> : null}
                      </a>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          {/* Upcoming occurrences */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-primary" /> Upcoming occurrences
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigateTo("pm", [], { tab: "schedule" })}>
                View all
              </Button>
            </CardHeader>
            <CardContent>
              {data.upcoming.length === 0 ? (
                <EmptyState title="Nothing scheduled" hint="Generate an occurrence from an active plan to schedule work." />
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto hms-scroll">
                  {data.upcoming.slice(0, 6).map((t) => {
                    const overdue = isTaskOpen(t.status) && daysOverdue(t.dueDate) > 0;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => navigateTo("pm", ["tasks", t.id])}
                        className="flex w-full flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 min-h-[44px] text-left hover:bg-accent/60 transition-colors"
                      >
                        <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{t.code}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{t.plan?.name ?? "—"}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {t.equipment ? `${t.equipment.name} (${t.equipment.assetTag})` : "—"}
                            {t.technicianName ? ` · ${t.technicianName}` : ""}
                          </span>
                        </span>
                        <span className={`text-xs whitespace-nowrap ${overdue ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
                          {fmtDate(t.dueDate)}
                        </span>
                        {t.priority ? <PriorityBadge priority={t.priority} /> : null}
                        <StatusBadge status={t.status} />
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">KPIs generated {fmtDateTime(data.generatedAt)} — refreshed live as the team works.</p>
        </div>
      )}
    </div>
  );
}

function PctCard({ title, pct, tone = "default", loading, formula, detail }: {
  title: string; pct: number | null; tone?: "default" | "success" | "warning"; loading?: boolean; formula: string; detail?: string;
}) {
  const toneCls = { default: "text-primary bg-primary/10", success: "text-emerald-600 bg-emerald-100", warning: "text-amber-600 bg-amber-100" }[tone];
  return (
    <Card className="shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${toneCls}`}>
            <Gauge className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</span>
              <TooltipProvider delayDuration={100}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`How is ${title.toLowerCase()} calculated?`}
                      className="rounded-full h-4 w-4 inline-flex items-center justify-center border border-muted-foreground/40 text-[9px] font-semibold text-muted-foreground hover:bg-muted"
                    >
                      i
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[250px] text-xs">{formula}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            {loading ? (
              <div className="text-lg font-semibold mt-0.5">—</div>
            ) : (
              <div className="text-lg font-semibold leading-tight mt-0.5">{pct === null || pct === undefined ? "—" : `${Math.round(pct)}%`}</div>
            )}
          </div>
        </div>
        <Progress value={Math.min(100, Math.max(0, pct ?? 0))} className="mt-3 h-1.5" aria-label={`${title} percentage`} />
        {detail && !loading ? <p className="mt-1.5 text-[11px] text-muted-foreground truncate" title={detail}>{detail}</p> : null}
      </CardContent>
    </Card>
  );
}
