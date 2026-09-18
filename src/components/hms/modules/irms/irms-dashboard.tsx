"use client";

// MOHD.HMS ENTERPRISE — IRMS dashboard (staff) + shared section nav + projects section.
//
// GET /api/v1/irms/dashboard powers the KPI StatCards (contract §10). Cards are
// permission-gated links via kpiHref() (KPI drill-down architecture) — Avg
// Completion is informational and stays non-clickable. Recent reports click
// through to the dedicated report detail page. IrmsSectionNav is rendered on
// EVERY staff IRMS page so users can move between IRMS sections without going
// back to the main nav. The Projects section keeps the existing projects list
// UX (DataTable + edit/delete) with projects/new and edit on dedicated pages.

import { useCallback, useEffect, useState } from "react";
import {
  Building2, CalendarDays, ClipboardCheck, FileText, Pencil, Plus, Send, Trash2, TrendingUp, UserCheck,
} from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate } from "@/lib/hms/format";
import { useRealtimeEventDebounced } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { humanize, PERMISSIONS, STATUS_TONE } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { kpiHref } from "@/lib/hms/kpi-nav";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { IrmsReportRow } from "./irms-reports-list";

// ── Shared section nav (rendered on ALL staff IRMS pages) ──

export type IrmsSection = "dashboard" | "projects" | "reports" | "calendar" | "analytics";

const SECTION_DEFS: { key: IrmsSection; label: string; seg: string[] }[] = [
  { key: "dashboard", label: "Dashboard", seg: [] },
  { key: "projects", label: "Projects", seg: ["projects"] },
  { key: "reports", label: "Reports", seg: ["reports"] },
  { key: "calendar", label: "Calendar", seg: ["calendar"] },
  { key: "analytics", label: "Analytics", seg: ["analytics"] },
];

export function IrmsSectionNav({ active }: { active: IrmsSection }) {
  return (
    <nav aria-label="IRMS sections" className="mb-5 -mx-1 overflow-x-auto px-1">
      <div className="flex w-max min-w-full items-center gap-1 rounded-lg border bg-muted/40 p-1">
        {SECTION_DEFS.map((s) => {
          const isActive = s.key === active;
          return (
            <a
              key={s.key}
              href={`/irms${s.seg.length ? `/${s.seg.join("/")}` : ""}`}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "inline-flex min-h-[40px] items-center justify-center whitespace-nowrap rounded-md px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background hover:text-foreground",
              )}
            >
              {s.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

// ── Dashboard ──

type DashboardPayload = {
  kpis: {
    total: number;
    drafts: number;
    submitted: number;
    inReview: number;
    managerApproval: number;
    clientReview: number;
    approved: number;
    rejected: number;
    archived: number;
    overdue: number;
    activeProjects: number;
    avgCompletion: number;
    photos: number;
    mine: number;
  };
  recent: IrmsReportRow[];
  byStatus: { status: string; count: number }[];
};

export function IrmsDashboardPage() {
  const { user } = useSession();

  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<DashboardPayload>("/api/v1/irms/dashboard");
      setData(res.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load the IRMS dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime: any IRMS lifecycle event refreshes KPIs (debounced; pageDirty-safe).
  useRealtimeEventDebounced(MODULE_EVENTS.irms, () => { void load(); });

  const kpis = data?.kpis;
  const pendingReports = kpis ? kpis.submitted + kpis.inReview + kpis.managerApproval + kpis.clientReview : 0;

  const myReportsHref = "/irms/reports?mine=1";

  return (
    <div>
      <IrmsSectionNav active="dashboard" />

      <PageHeader
        title="IRMS Inspections"
        subtitle="Inspection Report Management System — projects, site inspections and approvals"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => navigateTo("irms", ["calendar"])}>
              <CalendarDays className="h-4 w-4 mr-1.5" /> Calendar
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigateTo("irms", ["analytics"])}>
              <TrendingUp className="h-4 w-4 mr-1.5" /> Analytics
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigateTo("irms", ["projects"])}>
              <Building2 className="h-4 w-4 mr-1.5" /> Projects
            </Button>
            {hasPerm(user, PERMISSIONS.irms_create) ? (
              <Button size="sm" onClick={() => navigateTo("irms", ["reports", "new"])}>
                <FileText className="h-4 w-4 mr-1.5" /> New Inspection Report
              </Button>
            ) : null}
          </div>
        }
      />

      {loading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 7 }).map((_, i) => <StatCard key={i} title="…" value="—" loading />)}
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : kpis ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            <StatCard title="Completed Reports" value={kpis.approved} icon={<ClipboardCheck className="h-5 w-5" />} tone="success" href={kpiHref("irmsCompleted", user)} />
            <StatCard title="Pending Reports" value={pendingReports} icon={<Send className="h-5 w-5" />} tone="warning" href={kpiHref("irmsPending", user)} />
            <StatCard title="Drafts" value={kpis.drafts} icon={<FileText className="h-5 w-5" />} href={kpiHref("irmsDrafts", user)} />
            <StatCard title="Overdue Inspections" value={kpis.overdue} icon={<Send className="h-5 w-5" />} tone="danger" href={kpiHref("irmsOverdue", user)} />
            <StatCard title="Active Projects" value={kpis.activeProjects} icon={<Building2 className="h-5 w-5" />} href={kpiHref("irmsProjects", user)} />
            <StatCard title="Avg Completion" value={`${kpis.avgCompletion}%`} icon={<TrendingUp className="h-5 w-5" />} />
            <StatCard title="My Reports" value={kpis.mine} icon={<UserCheck className="h-5 w-5" />} href={hasPerm(user, PERMISSIONS.irms_read) ? myReportsHref : undefined} />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            {/* Recent reports */}
            <Card className="shadow-sm lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" aria-hidden /> Recent reports
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!data || data.recent.length === 0 ? (
                  <EmptyState
                    title="No inspection reports yet"
                    hint="Create the first inspection report to see it here."
                    action={hasPerm(user, PERMISSIONS.irms_create) ? (
                      <Button size="sm" onClick={() => navigateTo("irms", ["reports", "new"])}>
                        <FileText className="h-4 w-4 mr-1.5" /> New Inspection Report
                      </Button>
                    ) : undefined}
                  />
                ) : (
                  <ul className="divide-y">
                    {data.recent.map((r) => (
                      <li key={r.id}>
                        <a
                          href={`/irms/reports/${r.id}`}
                          className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{r.code}</span>
                              <StatusBadge status={r.status} />
                            </div>
                            <p className="mt-0.5 truncate text-sm text-muted-foreground">
                              {r.title} · {r.project?.name ?? "No project"} · {fmtDate(r.inspectionDate)}
                            </p>
                          </div>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* Status distribution + stats */}
            <div className="space-y-4">
              <Card className="shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">By status</CardTitle>
                </CardHeader>
                <CardContent>
                  {data && data.byStatus.length > 0 ? (
                    <ul className="space-y-1.5">
                      {data.byStatus.map((s) => (
                        <li key={s.status} className="flex items-center gap-2 text-sm">
                          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", (STATUS_TONE[s.status] ?? "bg-stone-300").split(" ")[0])} aria-hidden />
                          <span className="flex-1 text-muted-foreground">{humanize(s.status)}</span>
                          <span className="font-medium tabular-nums">{s.count}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No reports yet.</p>
                  )}
                </CardContent>
              </Card>
              <Card className="shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Evidence</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  <p><span className="text-lg font-semibold text-foreground tabular-nums">{kpis.total}</span> reports · <span className="text-lg font-semibold text-foreground tabular-nums">{kpis.photos}</span> photos</p>
                  <p className="mt-1 text-xs">Average completion across active reports is {kpis.avgCompletion}%.</p>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Projects section (existing list UX, dedicated routes for create/edit) ──

type CustomerRef = { id: string; companyName: string } | null;

export type IrmsProject = {
  id: string;
  code: string;
  name: string;
  siteLocation: string;
  description: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  customer: CustomerRef;
  inspectionsCount: number;
};

export function IrmsProjectsSection() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.irms_manage);

  const [projects, setProjects] = useState<IrmsProject[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IrmsProject | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<IrmsProject[]>(`/api/v1/irms/projects${qs({ pageSize: "200" })}`);
      setProjects(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load projects.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useRealtimeEventDebounced(MODULE_EVENTS.irms, () => { void load(); });

  const deleteProject = async (p: IrmsProject) => {
    const hasReports = p.inspectionsCount > 0;
    setBusyId(p.id);
    try {
      await api.del(`/api/v1/irms/projects/${p.id}`);
      toast({
        title: hasReports ? "Project completed" : "Project deleted",
        description: hasReports ? `${p.code} was marked COMPLETED (inspection history preserved).` : `${p.code} removed.`,
      });
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<IrmsProject>[] = [
    { key: "code", header: "Code", value: (p) => p.code, className: "font-medium whitespace-nowrap" },
    { key: "name", header: "Project", value: (p) => p.name },
    {
      key: "customer", header: "Customer", hideOnMobile: true,
      value: (p) => p.customer?.companyName ?? "",
      render: (p) => p.customer?.companyName ?? <span className="text-muted-foreground">Internal</span>,
    },
    { key: "siteLocation", header: "Site", value: (p) => p.siteLocation, hideOnMobile: true },
    {
      key: "inspectionsCount", header: "Reports", value: (p) => p.inspectionsCount,
      render: (p) => <span className="tabular-nums">{p.inspectionsCount}</span>,
    },
    {
      key: "period", header: "Period", hideOnMobile: true, sortable: false,
      value: (p) => p.startDate ?? "",
      render: (p) => (
        <span className="whitespace-nowrap text-sm">
          {fmtDate(p.startDate)} → {fmtDate(p.endDate)}
        </span>
      ),
    },
    { key: "status", header: "Status", value: (p) => p.status, render: (p) => <StatusBadge status={p.status} /> },
    ...(canManage
      ? [{
          key: "projActions", header: "", sortable: false,
          render: (p: IrmsProject) => (
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => navigateTo("irms", [p.id, "edit"])} aria-label={`Edit ${p.code}`}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="sm"
                disabled={busyId === p.id}
                onClick={() => setDeleteTarget(p)}
                aria-label={`Delete ${p.code}`}
              >
                <Trash2 className="h-3.5 w-3.5 text-red-600" />
              </Button>
            </div>
          ),
        } satisfies Column<IrmsProject>]
      : []),
  ];

  return (
    <div>
      <IrmsSectionNav active="projects" />
      <PageHeader
        title="Inspection Projects"
        subtitle="Group inspection reports by site, customer or contract"
        actions={
          canManage ? (
            <Button size="sm" onClick={() => navigateTo("irms", ["projects", "new"])}>
              <Plus className="h-4 w-4 mr-1.5" /> New Project
            </Button>
          ) : null
        }
      />

      {loading ? (
        <LoadingState label="Loading projects…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !projects || projects.length === 0 ? (
        <EmptyState
          title="No inspection projects"
          hint={canManage ? "Create a project to group inspection reports by site or customer." : "No projects have been created yet."}
          action={canManage ? <Button size="sm" onClick={() => navigateTo("irms", ["projects", "new"])}><Plus className="h-4 w-4 mr-1.5" /> New Project</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={projects}
          rowKey={(p) => p.id}
          onRowClick={canManage ? (p) => navigateTo("irms", [p.id, "edit"]) : undefined}
          searchPlaceholder="Search code, project, site…"
          emptyTitle="No projects match"
          exportName="irms-projects"
        />
      )}

      {/* Project delete confirmation (branch messages preserved) */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget && deleteTarget.inspectionsCount > 0
                ? `Delete ${deleteTarget.code}?`
                : deleteTarget
                  ? `Delete ${deleteTarget.code} — ${deleteTarget.name}?`
                  : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && deleteTarget.inspectionsCount > 0
                ? `${deleteTarget.code} has ${deleteTarget.inspectionsCount} inspection report(s). It cannot be deleted — mark it COMPLETED instead? Inspection history is preserved.`
                : "This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteTarget) void deleteProject(deleteTarget); }}
            >
              {deleteTarget && deleteTarget.inspectionsCount > 0 ? "Mark COMPLETED" : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
