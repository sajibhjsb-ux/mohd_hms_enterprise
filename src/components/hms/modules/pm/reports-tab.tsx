"use client";

// MOHD.HMS ENTERPRISE — PM Reports tab (PM spec §55–§57).
// Compliance hero (the ONE §56 formula, same as the dashboard), overdue table
// with days-overdue, technician performance, cost by asset / customer, findings
// summary. All figures come from GET /api/v1/pm/reports (server-computed from
// PostgreSQL) — no client-side invention. CSV export via DataTable exportName.

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { navigateTo } from "@/lib/hms/router";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import {
  EmptyState, ErrorState, LoadingState, Money, PageHeader, PriorityBadge, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Gauge, PlayCircle, ShieldAlert, TrendingUp, UserCog } from "lucide-react";

type ReportPayload = {
  windowDays: number;
  compliance: { compliancePct: number; completionPct: number; dueOccurrences: number; completedOnTime: number; excluded: number };
  overdue: {
    id: string; code: string; dueDate: string; daysOverdue: number; priority: string | null; status: string;
    equipmentName: string; equipmentAssetTag: string; customerName: string | null; technicianName: string | null; planName: string | null;
  }[];
  technicians: {
    technicianId: string; name: string; assigned: number; completed: number; overdue: number; failed: number;
    avgCompletionHours: number | null; checklistRate: number | null;
  }[];
  costsByAsset: { equipmentId: string; equipmentName: string; assetTag: string; workOrders: number; labourCents: number; materialsCents: number; totalCents: number }[];
  costsByCustomer: { customerId: string; customerName: string; workOrders: number; labourCents: number; materialsCents: number; totalCents: number }[];
  findingsSummary: { severity: string; count: number }[];
  upcoming: {
    id: string; code: string; dueDate: string; status: string; priority: string | null;
    plan: { name: string; code: string } | null;
    equipment: { name: string; assetTag: string } | null;
    technicianName: string | null;
  }[];
};

const WINDOW_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 180 days" },
  { value: "365", label: "Last 365 days" },
];

const SEVERITY_TONE: Record<string, string> = {
  LOW: "bg-stone-100 text-stone-700",
  MEDIUM: "bg-amber-100 text-amber-800",
  HIGH: "bg-orange-100 text-orange-800",
  CRITICAL: "bg-red-100 text-red-700",
};

export function PmReportsTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.pm_manage);

  const [windowDays, setWindowDays] = useState("90");
  const [data, setData] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningScheduler, setRunningScheduler] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ReportPayload>(`/api/v1/pm/reports${qs({ windowDays })}`);
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load PM reports.");
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => { load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.pm, () => { void load(); });

  const runScheduler = async () => {
    setRunningScheduler(true);
    try {
      await api.post("/api/v1/pm/scheduler/run", {});
      toast({ title: "Scheduler run complete", description: "Due occurrences were generated idempotently — running twice creates no duplicates." });
      void load();
    } catch (e) {
      toast({ title: "Scheduler run failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setRunningScheduler(false);
    }
  };

  const overdueColumns: Column<ReportPayload["overdue"][number]>[] = [
    { key: "code", header: "Task", value: (r) => r.code, render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: "plan", header: "Plan", value: (r) => r.planName ?? "", hideOnMobile: true },
    { key: "equipment", header: "Equipment", value: (r) => `${r.equipmentName} ${r.equipmentAssetTag}` },
    { key: "customer", header: "Customer", value: (r) => r.customerName ?? "", hideOnMobile: true },
    { key: "technician", header: "Technician", value: (r) => r.technicianName ?? "", hideOnMobile: true },
    {
      key: "due", header: "Due", value: (r) => r.dueDate,
      render: (r) => <span className="text-xs">{fmtDate(r.dueDate)}</span>,
    },
    {
      key: "days", header: "Days overdue", value: (r) => r.daysOverdue, sortable: true,
      render: (r) => <span className={`text-sm font-semibold tabular-nums ${r.daysOverdue > 0 ? "text-red-600" : ""}`}>{r.daysOverdue}</span>,
    },
    { key: "priority", header: "Priority", value: (r) => r.priority ?? "", render: (r) => (r.priority ? <PriorityBadge priority={r.priority} /> : "—") },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
  ];

  const techColumns: Column<ReportPayload["technicians"][number]>[] = [
    { key: "name", header: "Technician", value: (r) => r.name },
    { key: "assigned", header: "Assigned", value: (r) => r.assigned, render: (r) => <span className="tabular-nums">{r.assigned}</span> },
    { key: "completed", header: "Completed", value: (r) => r.completed, render: (r) => <span className="tabular-nums text-emerald-700 font-medium">{r.completed}</span> },
    { key: "overdue", header: "Overdue", value: (r) => r.overdue, render: (r) => <span className={`tabular-nums ${r.overdue > 0 ? "text-red-600 font-medium" : ""}`}>{r.overdue}</span> },
    { key: "failed", header: "Failed", value: (r) => r.failed, render: (r) => <span className="tabular-nums">{r.failed}</span> },
    {
      key: "avg", header: "Avg completion", value: (r) => r.avgCompletionHours ?? 0,
      render: (r) => <span className="tabular-nums">{r.avgCompletionHours === null ? "—" : `${r.avgCompletionHours} h`}</span>,
    },
    {
      key: "checklist", header: "Checklist rate", value: (r) => r.checklistRate ?? 0,
      render: (r) => <span className="tabular-nums">{r.checklistRate === null ? "—" : `${Math.round(r.checklistRate * 100)}%`}</span>,
    },
  ];

  const assetCostColumns: Column<ReportPayload["costsByAsset"][number]>[] = [
    { key: "equipment", header: "Equipment", value: (r) => `${r.equipmentName} (${r.assetTag})` },
    { key: "workOrders", header: "PM jobs", value: (r) => r.workOrders, render: (r) => <span className="tabular-nums">{r.workOrders}</span> },
    { key: "labour", header: "Labour", value: (r) => r.labourCents, render: (r) => <Money cents={r.labourCents} className="tabular-nums text-sm" /> },
    { key: "materials", header: "Parts", value: (r) => r.materialsCents, render: (r) => <Money cents={r.materialsCents} className="tabular-nums text-sm" /> },
    { key: "total", header: "Total", value: (r) => r.totalCents, render: (r) => <Money cents={r.totalCents} className="tabular-nums text-sm font-semibold" /> },
  ];

  const customerCostColumns: Column<ReportPayload["costsByCustomer"][number]>[] = [
    { key: "customer", header: "Customer", value: (r) => r.customerName },
    { key: "workOrders", header: "PM jobs", value: (r) => r.workOrders, render: (r) => <span className="tabular-nums">{r.workOrders}</span> },
    { key: "labour", header: "Labour", value: (r) => r.labourCents, render: (r) => <Money cents={r.labourCents} className="tabular-nums text-sm" /> },
    { key: "materials", header: "Parts", value: (r) => r.materialsCents, render: (r) => <Money cents={r.materialsCents} className="tabular-nums text-sm" /> },
    { key: "total", header: "Total", value: (r) => r.totalCents, render: (r) => <Money cents={r.totalCents} className="tabular-nums text-sm font-semibold" /> },
  ];

  return (
    <div>
      <PageHeader
        title="PM Reports"
        subtitle="Compliance, technician performance and maintenance costs — computed from real records"
        actions={
          <div className="flex items-center gap-2">
            <Select value={windowDays} onValueChange={setWindowDays}>
              <SelectTrigger className="h-9 w-[150px]" aria-label="Report window"><SelectValue /></SelectTrigger>
              <SelectContent>{WINDOW_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
            {canManage ? (
              <Button variant="outline" size="sm" onClick={runScheduler} disabled={runningScheduler} className="min-h-[36px]">
                <PlayCircle className="h-4 w-4 mr-1.5" /> {runningScheduler ? "Running…" : "Run scheduler"}
              </Button>
            ) : null}
          </div>
        }
      />

      {loading && !data ? (
        <LoadingState label="Computing PM reports…" rows={5} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data ? (
        <EmptyState title="No report data" hint="Reports appear once PM plans and occurrences exist." />
      ) : (
        <div className="space-y-5">
          {/* Compliance hero — the ONE centralized §56 formula */}
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Gauge className="h-4 w-4 text-primary" /> PM compliance — last {data.windowDays} days
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <ComplianceBar
                label="Compliance" pct={data.compliance.compliancePct}
                formula="Completed on time ÷ due occurrences (skipped/cancelled excluded)."
                detail={`${data.compliance.completedOnTime}/${data.compliance.dueOccurrences} on time · ${data.compliance.excluded} skipped/cancelled excluded`}
              />
              <ComplianceBar
                label="Completion" pct={data.compliance.completionPct} tone="success"
                formula="Completed occurrences ÷ due occurrences — on time or late."
                detail={`${data.compliance.completed}/${data.compliance.dueOccurrences} completed`}
              />
            </CardContent>
          </Card>

          {/* Overdue */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-red-600" /> Overdue maintenance
              </CardTitle>
              <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">{data.overdue.length} open</Badge>
            </CardHeader>
            <CardContent>
              {data.overdue.length === 0 ? (
                <EmptyState title="Nothing overdue" hint="Every due occurrence is on track for this window." />
              ) : (
                <DataTable
                  columns={overdueColumns}
                  rows={data.overdue}
                  rowKey={(r) => r.id}
                  searchPlaceholder="Search overdue…"
                  exportName="pm-overdue"
                  pageSizeDefault={10}
                  onRowClick={(r) => navigateTo("pm", ["tasks", r.id])}
                />
              )}
            </CardContent>
          </Card>

          {/* Technician performance (§57 — objective metrics only) */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <UserCog className="h-4 w-4 text-primary" /> Technician PM performance
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.technicians.length === 0 ? (
                <EmptyState title="No assignments yet" hint="Assign technicians to PM plans to see performance." />
              ) : (
                <DataTable
                  columns={techColumns}
                  rows={data.technicians}
                  rowKey={(r) => r.technicianId}
                  searchPlaceholder="Search technician…"
                  exportName="pm-technician-performance"
                  pageSizeDefault={10}
                />
              )}
            </CardContent>
          </Card>

          {/* Costs */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" /> PM cost by asset
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.costsByAsset.length === 0 ? (
                  <EmptyState title="No completed PM jobs" hint="Costs appear once PM work orders complete." />
                ) : (
                  <DataTable columns={assetCostColumns} rows={data.costsByAsset} rowKey={(r) => r.equipmentId} searchPlaceholder="Search asset…" exportName="pm-cost-by-asset" pageSizeDefault={10} />
                )}
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" /> PM cost by customer
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.costsByCustomer.length === 0 ? (
                  <EmptyState title="No completed PM jobs" hint="Costs appear once PM work orders complete." />
                ) : (
                  <DataTable columns={customerCostColumns} rows={data.costsByCustomer} rowKey={(r) => r.customerId} searchPlaceholder="Search customer…" exportName="pm-cost-by-customer" pageSizeDefault={10} />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Findings summary */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Findings summary</CardTitle>
            </CardHeader>
            <CardContent>
              {data.findingsSummary.length === 0 ? (
                <p className="text-sm text-muted-foreground">No findings recorded in this window.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {data.findingsSummary.map((f) => (
                    <Badge key={f.severity} variant="outline" className={`${SEVERITY_TONE[f.severity] ?? ""} border-transparent`}>
                      {f.severity}: {f.count}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function ComplianceBar({ label, pct, tone = "default", formula, detail }: {
  label: string; pct: number; tone?: "default" | "success"; formula: string; detail?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className={`text-2xl font-bold tabular-nums ${tone === "success" ? "text-emerald-600" : "text-primary"}`}>{Math.round(pct)}%</span>
      </div>
      <Progress value={Math.min(100, Math.max(0, pct))} className="mt-2 h-2" aria-label={`${label} percentage`} />
      <p className="mt-1.5 text-[11px] text-muted-foreground" title={formula}>{formula}</p>
      {detail ? <p className="text-[11px] text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
