"use client";

// IRMS module — inspection projects + inspection reports with the
// draft → submitted → approved workflow.
//
// NAVIGATION ARCHITECTURE: every business form/detail is a DEDICATED PAGE
// routed by the hash router (ui-store pages["irms"]) — no popup CRUD:
//   ["projects", "new"]        → New Inspection Project page (draft-backed)
//   [projectId, "edit"]        → Edit Project page     (also ["projects", id, "edit"])
//   ["reports", "new"]         → New Inspection Report page (draft-backed)
//   [reportId]                 → Report detail page    (also ["reports", id])
// Project delete keeps its branch messages via an AlertDialog (no
// window.confirm). Projects have no detail page — row click opens edit per the
// existing UX.

import { useCallback, useEffect, useState } from "react";
import {
  Building2, ClipboardCheck, FileText, Plus, Send, Trash2, Pencil,
} from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate } from "@/lib/hms/format";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { IrmsProjectNewPage, IrmsProjectEditPage } from "./project-page";
import { IrmsReportNewPage } from "./report-new-page";
import { IrmsReportDetailPage } from "./report-detail-page";

// ── Types ──

type CustomerRef = { id: string; companyName: string } | null;
type EquipmentRef = { id: string; name: string; assetTag: string } | null;

type IrmsProject = {
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

type InspectionReport = {
  id: string;
  code: string;
  title: string;
  type: string;
  status: string;
  inspectionDate: string;
  summary: string;
  overallCondition: string;
  recommendations: string;
  project: { id: string; name: string; code: string; customer?: { companyName: string } | null } | null;
  equipment: EquipmentRef;
  inspector: { id: string; user?: { name?: string | null } | null } | null;
  findingsCount?: number;
};

// ── Module router ──

export function IrmsModule() {
  const seg = useUi((s) => s.pages["irms"]) ?? [];
  const page = pageFromSeg(seg);

  // Create: #/irms/projects/new
  if (page.view === "projects" && page.id === "new") return <IrmsProjectNewPage />;
  // Edit: #/irms/{id}/edit (2-seg → view "edit") or #/irms/projects/{id}/edit (3-seg → view "projects-edit")
  if ((page.view === "edit" || page.view === "projects-edit") && page.id) return <IrmsProjectEditPage id={page.id} />;
  // Create: #/irms/reports/new
  if (page.view === "reports" && page.id === "new") return <IrmsReportNewPage />;
  // Detail: #/irms/{id} (view "detail") or #/irms/reports/{id} (prefix view)
  if (page.view === "detail" && page.id) return <IrmsReportDetailPage id={page.id} />;
  if (page.view === "reports" && page.id) return <IrmsReportDetailPage id={page.id} />;
  return <IrmsList />;
}

// ── List page ──

function IrmsList() {
  const { user } = useSession();
  const { toast } = useToast();

  const canManage = hasPerm(user, PERMISSIONS.irms_manage);

  // All page navigation flows through the hash router (URL + Back/Forward).
  const openPage = useCallback((seg: string[]) => navigateTo("irms", seg), []);

  // ── Data ──
  const [projects, setProjects] = useState<IrmsProject[]>([]);
  const [reports, setReports] = useState<InspectionReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("projects");

  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IrmsProject | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projectsRes, reportsRes] = await Promise.all([
        api.get<IrmsProject[]>(`/api/v1/irms/projects${qs({ pageSize: "200" })}`),
        api.get<InspectionReport[]>(`/api/v1/irms/reports${qs({ pageSize: "200" })}`),
      ]);
      setProjects(projectsRes.data ?? []);
      setReports(reportsRes.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load IRMS data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Project delete (branch messages preserved; window.confirm → AlertDialog) ──
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

  // ── Project columns ──
  const projectColumns: Column<IrmsProject>[] = [
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
              <Button variant="outline" size="sm" onClick={() => openPage([p.id, "edit"])} aria-label={`Edit ${p.code}`}>
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

  // ── Report columns ──
  const reportColumns: Column<InspectionReport>[] = [
    { key: "code", header: "Code", value: (r) => r.code, className: "font-medium whitespace-nowrap" },
    { key: "title", header: "Title", value: (r) => r.title },
    { key: "project", header: "Project", value: (r) => r.project?.name ?? "", hideOnMobile: true, render: (r) => r.project?.name ?? "—" },
    { key: "type", header: "Type", value: (r) => r.type, render: (r) => humanize(r.type), hideOnMobile: true },
    { key: "inspectionDate", header: "Date", value: (r) => r.inspectionDate, render: (r) => fmtDate(r.inspectionDate) },
    {
      key: "inspector", header: "Inspector", hideOnMobile: true,
      value: (r) => r.inspector?.user?.name ?? "",
      render: (r) => r.inspector?.user?.name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: "overallCondition", header: "Condition", hideOnMobile: true,
      value: (r) => r.overallCondition, render: (r) => <StatusBadge status={r.overallCondition} />,
    },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div>
      <PageHeader
        title="IRMS Inspections"
        subtitle="Inspection Report Management System — projects, site inspections and approvals"
        actions={
          canManage ? (
            <>
              <Button variant="outline" size="sm" onClick={() => openPage(["reports", "new"])}>
                <FileText className="h-4 w-4 mr-1.5" /> New Report
              </Button>
              <Button size="sm" onClick={() => openPage(["projects", "new"])}>
                <Plus className="h-4 w-4 mr-1.5" /> New Project
              </Button>
            </>
          ) : null
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard title="Projects" value={projects.length} icon={<Building2 className="h-5 w-5" />} loading={loading} />
        <StatCard title="Active Projects" value={projects.filter((p) => p.status === "ACTIVE").length} icon={<ClipboardCheck className="h-5 w-5" />} tone="success" loading={loading} />
        <StatCard title="Inspection Reports" value={reports.length} icon={<FileText className="h-5 w-5" />} loading={loading} />
        <StatCard title="Awaiting Approval" value={reports.filter((r) => r.status === "SUBMITTED").length} icon={<Send className="h-5 w-5" />} tone="warning" loading={loading} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="projects"><Building2 className="h-4 w-4 mr-1.5" /> Projects</TabsTrigger>
          <TabsTrigger value="reports"><FileText className="h-4 w-4 mr-1.5" /> Inspection Reports</TabsTrigger>
        </TabsList>

        <TabsContent value="projects">
          {loading ? (
            <LoadingState label="Loading projects…" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : projects.length === 0 ? (
            <EmptyState
              title="No inspection projects"
              hint={canManage ? "Create a project to group inspection reports by site or customer." : "No projects have been created yet."}
              action={canManage ? <Button size="sm" onClick={() => openPage(["projects", "new"])}><Plus className="h-4 w-4 mr-1.5" /> New Project</Button> : undefined}
            />
          ) : (
            <DataTable
              columns={projectColumns}
              rows={projects}
              rowKey={(p) => p.id}
              onRowClick={canManage ? (p) => openPage([p.id, "edit"]) : undefined}
              searchPlaceholder="Search code, project, site…"
              emptyTitle="No projects match"
              exportName="irms-projects"
            />
          )}
        </TabsContent>

        <TabsContent value="reports">
          {loading ? (
            <LoadingState label="Loading inspection reports…" />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : reports.length === 0 ? (
            <EmptyState
              title="No inspection reports"
              hint={canManage ? "Create the first inspection report against a project." : "No reports have been filed yet."}
              action={canManage ? <Button size="sm" onClick={() => openPage(["reports", "new"])}><FileText className="h-4 w-4 mr-1.5" /> New Report</Button> : undefined}
            />
          ) : (
            <DataTable
              columns={reportColumns}
              rows={reports}
              rowKey={(r) => r.id}
              onRowClick={(r) => openPage([r.id])}
              searchPlaceholder="Search code, title, project…"
              emptyTitle="No reports match"
              exportName="inspection-reports"
            />
          )}
        </TabsContent>
      </Tabs>

      {/* ── Project delete confirmation (branches preserved from window.confirm) ── */}
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
