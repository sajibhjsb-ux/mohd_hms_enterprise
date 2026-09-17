"use client";

// IRMS module — inspection projects + inspection reports with findings,
// draft → submitted → approved workflow and a print-ready report document.

import { useCallback, useEffect, useState, type ReactNode, type CSSProperties } from "react";
import {
  Building2, ClipboardCheck, FileText, Plus, Printer, Send, CheckCheck, Trash2, Pencil,
} from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate, toDateInput } from "@/lib/hms/format";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
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
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

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

type InspectionFinding = {
  id: string;
  finding: string;
  severity: string;
  recommendation: string;
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
  findings: InspectionFinding[];
  findingsCount?: number;
};

type Option = { id: string; label: string };

const PROJECT_STATUSES = ["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED"];
const REPORT_TYPES = ["ROUTINE", "SAFETY", "EQUIPMENT", "PROJECT", "OTHER"];
const CONDITIONS = ["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const emptyProjectForm = {
  name: "",
  customerId: "",
  siteLocation: "",
  description: "",
  startDate: "",
  endDate: "",
};

type FindingDraft = { finding: string; severity: string; recommendation: string };

const emptyReportForm = {
  projectId: "",
  equipmentId: "",
  title: "",
  type: "ROUTINE",
  inspectionDate: "",
  overallCondition: "GOOD",
  summary: "",
  recommendations: "",
};

export function IrmsModule() {
  const { user } = useSession();
  const { toast } = useToast();

  const canManage = hasPerm(user, PERMISSIONS.irms_manage);

  // ── Data ──
  const [projects, setProjects] = useState<IrmsProject[]>([]);
  const [reports, setReports] = useState<InspectionReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("projects");

  const [customerOptions, setCustomerOptions] = useState<Option[] | null>(null);
  const [equipmentOptions, setEquipmentOptions] = useState<Option[] | null>(null);

  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // ── Project dialogs ──
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<IrmsProject | null>(null);
  const [projectForm, setProjectForm] = useState(emptyProjectForm);
  const [projectStatus, setProjectStatus] = useState("ACTIVE");
  const projectDraft = useDraft({ formKey: "irms.project.create", initial: emptyProjectForm });

  // ── Report dialogs ──
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [reportFindings, setReportFindings] = useState<FindingDraft[]>([]);
  const reportDraft = useDraft({ formKey: "irms.report.create", initial: emptyReportForm });

  const [detailReport, setDetailReport] = useState<InspectionReport | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ id: string; companyName: string }[]>(`/api/v1/customers${qs({ pageSize: "200" })}`);
        setCustomerOptions((res.data ?? []).map((c) => ({ id: c.id, label: c.companyName })));
      } catch {
        setCustomerOptions(null);
      }
    })();
    (async () => {
      try {
        const res = await api.get<EquipmentRef[]>(`/api/v1/equipment${qs({ pageSize: "200" })}`);
        setEquipmentOptions(((res.data ?? []) as { id: string; name: string; assetTag: string }[]).map((e) => ({
          id: e.id,
          label: `${e.name} (${e.assetTag})`,
        })));
      } catch {
        setEquipmentOptions(null);
      }
    })();
  }, []);

  // ── Project actions ──
  const openCreateProject = () => {
    setEditingProject(null);
    setProjectDialogOpen(true);
  };

  const openEditProject = (p: IrmsProject) => {
    setEditingProject(p);
    setProjectForm({
      name: p.name,
      customerId: p.customer?.id ?? "",
      siteLocation: p.siteLocation,
      description: p.description,
      startDate: toDateInput(p.startDate),
      endDate: toDateInput(p.endDate),
    });
    setProjectStatus(p.status);
    setProjectDialogOpen(true);
  };

  const saveProject = async () => {
    const name = editingProject ? projectForm.name : projectDraft.value.name;
    if (!name.trim()) {
      toast({ title: "Project name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        customerId: (editingProject ? projectForm.customerId : projectDraft.value.customerId) || null,
        siteLocation: (editingProject ? projectForm.siteLocation : projectDraft.value.siteLocation).trim(),
        description: (editingProject ? projectForm.description : projectDraft.value.description).trim(),
        startDate: (editingProject ? projectForm.startDate : projectDraft.value.startDate) || null,
        endDate: (editingProject ? projectForm.endDate : projectDraft.value.endDate) || null,
        ...(editingProject ? { status: projectStatus } : {}),
      };
      if (editingProject) {
        await api.patch(`/api/v1/irms/projects/${editingProject.id}`, payload);
        toast({ title: "Project updated", description: `${editingProject.code} saved.` });
      } else {
        const res = await api.post<IrmsProject>("/api/v1/irms/projects", payload);
        toast({ title: "Project created", description: `${res.data.code} — ${res.data.name}.` });
      }
      if (!editingProject) projectDraft.reset(emptyProjectForm);
      setProjectDialogOpen(false);
      await load();
    } catch (e) {
      toast({ title: editingProject ? "Update failed" : "Could not create project", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const deleteProject = async (p: IrmsProject) => {
    const hasReports = p.inspectionsCount > 0;
    const msg = hasReports
      ? `${p.code} has ${p.inspectionsCount} inspection report(s). It cannot be deleted — mark it COMPLETED instead?`
      : `Delete ${p.code} — ${p.name}? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    setBusyId(p.id);
    try {
      await api.del(`/api/v1/irms/projects/${p.id}`);
      toast({
        title: hasReports ? "Project completed" : "Project deleted",
        description: hasReports ? `${p.code} was marked COMPLETED (inspection history preserved).` : `${p.code} removed.`,
      });
      await load();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  // ── Report actions ──
  const openCreateReport = () => {
    setReportFindings([]);
    setReportDialogOpen(true);
  };

  const saveReport = async () => {
    const v = reportDraft.value;
    if (!v.projectId) {
      toast({ title: "Select a project", variant: "destructive" });
      return;
    }
    if (!v.title.trim()) {
      toast({ title: "Report title is required", variant: "destructive" });
      return;
    }
    const findings = reportFindings.map((f) => f.finding.trim()).filter(Boolean);
    if (reportFindings.some((f) => !f.finding.trim())) {
      toast({ title: "Some finding rows are empty", description: "Fill or remove empty finding rows.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<InspectionReport>("/api/v1/irms/reports", {
        projectId: v.projectId,
        equipmentId: v.equipmentId || null,
        title: v.title.trim(),
        type: v.type,
        inspectionDate: v.inspectionDate || null,
        overallCondition: v.overallCondition,
        summary: v.summary.trim(),
        recommendations: v.recommendations.trim(),
        findings: reportFindings
          .filter((f) => f.finding.trim())
          .map((f) => ({ finding: f.finding.trim(), severity: f.severity, recommendation: f.recommendation.trim() })),
      });
      toast({ title: "Report created as draft", description: `${res.data.code} — ${res.data.title}.` });
      reportDraft.reset(emptyReportForm);
      setReportFindings([]);
      setReportDialogOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Could not create report", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (r: InspectionReport) => {
    setDetailLoading(true);
    setDetailReport(r);
    try {
      const res = await api.get<InspectionReport>(`/api/v1/irms/reports/${r.id}`);
      setDetailReport(res.data);
    } catch {
      // keep the list row data in the dialog
    } finally {
      setDetailLoading(false);
    }
  };

  const transitionReport = async (r: InspectionReport, action: "submit" | "approve") => {
    setBusyId(r.id);
    try {
      await api.post(`/api/v1/irms/reports/${r.id}/transition`, { action });
      toast({
        title: action === "submit" ? "Report submitted" : "Report approved",
        description: `${r.code} is now ${action === "submit" ? "SUBMITTED (awaiting approval)" : "APPROVED"}.`,
      });
      setDetailReport(null);
      await load();
    } catch (e) {
      toast({ title: action === "submit" ? "Submit failed" : "Approval failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const deleteReport = async (r: InspectionReport) => {
    if (!window.confirm(`Delete draft ${r.code} — ${r.title}? This cannot be undone.`)) return;
    setBusyId(r.id);
    try {
      await api.del(`/api/v1/irms/reports/${r.id}`);
      toast({ title: "Draft deleted", description: `${r.code} removed.` });
      setDetailReport(null);
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
              <Button variant="outline" size="sm" onClick={() => openEditProject(p)} aria-label={`Edit ${p.code}`}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="sm"
                disabled={busyId === p.id}
                onClick={() => void deleteProject(p)}
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

  const detail = detailReport;

  return (
    <div>
      <PageHeader
        title="IRMS Inspections"
        subtitle="Inspection Report Management System — projects, site inspections and approvals"
        actions={
          canManage ? (
            <>
              <Button variant="outline" size="sm" onClick={openCreateReport}>
                <FileText className="h-4 w-4 mr-1.5" /> New Report
              </Button>
              <Button size="sm" onClick={openCreateProject}>
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
              action={canManage ? <Button size="sm" onClick={openCreateProject}><Plus className="h-4 w-4 mr-1.5" /> New Project</Button> : undefined}
            />
          ) : (
            <DataTable
              columns={projectColumns}
              rows={projects}
              rowKey={(p) => p.id}
              onRowClick={canManage ? (p) => openEditProject(p) : undefined}
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
              action={canManage ? <Button size="sm" onClick={openCreateReport}><FileText className="h-4 w-4 mr-1.5" /> New Report</Button> : undefined}
            />
          ) : (
            <DataTable
              columns={reportColumns}
              rows={reports}
              rowKey={(r) => r.id}
              onRowClick={(r) => void openDetail(r)}
              searchPlaceholder="Search code, title, project…"
              emptyTitle="No reports match"
              exportName="inspection-reports"
            />
          )}
        </TabsContent>
      </Tabs>

      {/* ── Project create/edit dialog ── */}
      <Dialog open={projectDialogOpen} onOpenChange={(open) => { if (!open) setEditingProject(null); setProjectDialogOpen(open); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto hms-scroll">
          <DialogHeader>
            <DialogTitle>{editingProject ? `Edit ${editingProject.code}` : "New Inspection Project"}</DialogTitle>
            <DialogDescription>
              {editingProject
                ? "Update project details or status."
                : "Group inspection reports under a site project. Draft is auto-saved."}
              {!editingProject && projectDraft.draftExists ? (
                <button type="button" className="ml-1 underline underline-offset-2 text-primary" onClick={projectDraft.restore}>
                  Restore saved draft
                </button>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="prj-name">Project Name *</Label>
              <Input
                id="prj-name"
                value={editingProject ? projectForm.name : projectDraft.value.name}
                onChange={(e) => {
                  if (editingProject) setProjectForm((f) => ({ ...f, name: e.target.value }));
                  else projectDraft.setValue({ name: e.target.value });
                }}
                placeholder="Sunrise Mall Annual Facility Audit"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Customer</Label>
              <Select
                value={(editingProject ? projectForm.customerId : projectDraft.value.customerId) || "NONE"}
                onValueChange={(v) => {
                  const id = v === "NONE" ? "" : v;
                  if (editingProject) setProjectForm((f) => ({ ...f, customerId: id }));
                  else projectDraft.setValue({ customerId: id });
                }}
                disabled={customerOptions === null}
              >
                <SelectTrigger aria-label="Customer"><SelectValue placeholder={customerOptions === null ? "Unavailable" : "Internal"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Internal / No customer</SelectItem>
                  {(customerOptions ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prj-site">Site Location</Label>
              <Input
                id="prj-site"
                value={editingProject ? projectForm.siteLocation : projectDraft.value.siteLocation}
                onChange={(e) => {
                  if (editingProject) setProjectForm((f) => ({ ...f, siteLocation: e.target.value }));
                  else projectDraft.setValue({ siteLocation: e.target.value });
                }}
                placeholder="Bukit Bintang, Kuala Lumpur"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prj-start">Start Date</Label>
              <Input
                id="prj-start" type="date"
                value={editingProject ? projectForm.startDate : projectDraft.value.startDate}
                onChange={(e) => {
                  if (editingProject) setProjectForm((f) => ({ ...f, startDate: e.target.value }));
                  else projectDraft.setValue({ startDate: e.target.value });
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prj-end">End Date</Label>
              <Input
                id="prj-end" type="date"
                value={editingProject ? projectForm.endDate : projectDraft.value.endDate}
                onChange={(e) => {
                  if (editingProject) setProjectForm((f) => ({ ...f, endDate: e.target.value }));
                  else projectDraft.setValue({ endDate: e.target.value });
                }}
              />
            </div>
            {editingProject ? (
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={projectStatus} onValueChange={setProjectStatus}>
                  <SelectTrigger aria-label="Project status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROJECT_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="prj-desc">Description</Label>
              <Textarea
                id="prj-desc" rows={3}
                value={editingProject ? projectForm.description : projectDraft.value.description}
                onChange={(e) => {
                  if (editingProject) setProjectForm((f) => ({ ...f, description: e.target.value }));
                  else projectDraft.setValue({ description: e.target.value });
                }}
                placeholder="Scope of the inspection programme…"
              />
            </div>
          </div>

          <DialogFooter>
            {!editingProject ? (
              <span className="text-xs text-muted-foreground mr-auto">
                {projectDraft.dirty ? "Draft auto-saved" : ""}
              </span>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setProjectDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button onClick={() => void saveProject()} disabled={saving}>
                {saving ? "Saving…" : editingProject ? "Save Changes" : "Create Project"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── New Report dialog ── */}
      <Dialog open={reportDialogOpen} onOpenChange={(open) => { if (!open) setReportFindings([]); setReportDialogOpen(open); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto hms-scroll">
          <DialogHeader>
            <DialogTitle>New Inspection Report</DialogTitle>
            <DialogDescription>
              Reports start as DRAFT and go through submit → approve.
              {reportDraft.draftExists ? (
                <button type="button" className="ml-1 underline underline-offset-2 text-primary" onClick={reportDraft.restore}>
                  Restore saved draft
                </button>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label>Project *</Label>
              <Select value={reportDraft.value.projectId || undefined} onValueChange={(v) => reportDraft.setValue({ projectId: v })}>
                <SelectTrigger aria-label="Project"><SelectValue placeholder="Select project" /></SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Equipment</Label>
              <Select
                value={reportDraft.value.equipmentId || "NONE"}
                onValueChange={(v) => reportDraft.setValue({ equipmentId: v === "NONE" ? "" : v })}
                disabled={equipmentOptions === null}
              >
                <SelectTrigger aria-label="Equipment"><SelectValue placeholder={equipmentOptions === null ? "Unavailable" : "None"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Not equipment-specific</SelectItem>
                  {(equipmentOptions ?? []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ins-title">Title *</Label>
              <Input
                id="ins-title"
                value={reportDraft.value.title}
                onChange={(e) => reportDraft.setValue({ title: e.target.value })}
                placeholder="Quarterly HVAC system inspection"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={reportDraft.value.type} onValueChange={(v) => reportDraft.setValue({ type: v })}>
                <SelectTrigger aria-label="Report type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REPORT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ins-date">Inspection Date</Label>
              <Input
                id="ins-date" type="date"
                value={reportDraft.value.inspectionDate}
                onChange={(e) => reportDraft.setValue({ inspectionDate: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Overall Condition</Label>
              <Select value={reportDraft.value.overallCondition} onValueChange={(v) => reportDraft.setValue({ overallCondition: v })}>
                <SelectTrigger aria-label="Overall condition"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONDITIONS.map((c) => (
                    <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ins-summary">Summary</Label>
              <Textarea
                id="ins-summary" rows={3}
                value={reportDraft.value.summary}
                onChange={(e) => reportDraft.setValue({ summary: e.target.value })}
                placeholder="Executive summary of the inspection…"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ins-recs">Recommendations</Label>
              <Textarea
                id="ins-recs" rows={3}
                value={reportDraft.value.recommendations}
                onChange={(e) => reportDraft.setValue({ recommendations: e.target.value })}
                placeholder="Corrective actions, follow-ups, next inspection date…"
              />
            </div>

            <div className="sm:col-span-2 space-y-2">
              <div className="flex items-center justify-between">
                <Label>Findings</Label>
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={() => setReportFindings((f) => [...f, { finding: "", severity: "MEDIUM", recommendation: "" }])}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add Finding
                </Button>
              </div>
              {reportFindings.length === 0 ? (
                <p className="text-sm text-muted-foreground">No findings yet — add rows for each observation.</p>
              ) : (
                <div className="space-y-3">
                  {reportFindings.map((f, idx) => (
                    <div key={idx} className="rounded-lg border p-3 space-y-2 bg-muted/20">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">Finding {idx + 1}</span>
                        <div className="ml-auto">
                          <Button
                            type="button" variant="ghost" size="sm"
                            onClick={() => setReportFindings((rows) => rows.filter((_, i) => i !== idx))}
                            aria-label={`Remove finding ${idx + 1}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-red-600" />
                          </Button>
                        </div>
                      </div>
                      <Textarea
                        rows={2}
                        value={f.finding}
                        onChange={(e) => setReportFindings((rows) => rows.map((r, i) => (i === idx ? { ...r, finding: e.target.value } : r)))}
                        placeholder="Describe the observation…"
                        aria-label={`Finding ${idx + 1} description`}
                      />
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <Select
                          value={f.severity}
                          onValueChange={(v) => setReportFindings((rows) => rows.map((r, i) => (i === idx ? { ...r, severity: v } : r)))}
                        >
                          <SelectTrigger aria-label={`Severity for finding ${idx + 1}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {SEVERITIES.map((s) => (
                              <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          value={f.recommendation}
                          onChange={(e) => setReportFindings((rows) => rows.map((r, i) => (i === idx ? { ...r, recommendation: e.target.value } : r)))}
                          placeholder="Recommendation (optional)"
                          aria-label={`Recommendation for finding ${idx + 1}`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <span className="text-xs text-muted-foreground mr-auto">
              {reportDraft.dirty ? "Draft auto-saved" : ""}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setReportDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button onClick={() => void saveReport()} disabled={saving}>
                {saving ? "Creating…" : "Create Draft Report"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Report detail dialog + print document ── */}
      {detail && printCss}
      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetailReport(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto hms-scroll">
          <DialogTitle className="sr-only">Details</DialogTitle>
          {detailLoading && !detail ? <LoadingState label="Loading report…" rows={2} /> : null}
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  {detail.code} — {detail.title}
                  <StatusBadge status={detail.status} />
                </DialogTitle>
                <DialogDescription>
                  {detail.project ? `${detail.project.code} · ${detail.project.name}` : "Unlinked"} · {humanize(detail.type)}
                </DialogDescription>
              </DialogHeader>

              <div className="hidden print:block" id="irms-print-doc">
                {/* ── Print-only document ── */}
                <div style={{ textAlign: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>MOHD.HMS ENTERPRISE</div>
                  <div style={{ fontSize: 14, marginTop: 4 }}>Inspection Report</div>
                </div>
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginBottom: 16 }}>
                  <tbody>
                    <tr><td style={printTd}>Report Code</td><td style={printTd}>{detail.code}</td><td style={printTd}>Date</td><td style={printTd}>{fmtDate(detail.inspectionDate)}</td></tr>
                    <tr><td style={printTd}>Project</td><td style={printTd}>{detail.project ? `${detail.project.code} — ${detail.project.name}` : "—"}</td><td style={printTd}>Customer</td><td style={printTd}>{detail.project?.customer?.companyName ?? "—"}</td></tr>
                    <tr><td style={printTd}>Equipment</td><td style={printTd}>{detail.equipment ? `${detail.equipment.name} (${detail.equipment.assetTag})` : "—"}</td><td style={printTd}>Type</td><td style={printTd}>{humanize(detail.type)}</td></tr>
                    <tr><td style={printTd}>Inspector</td><td style={printTd}>{detail.inspector?.user?.name ?? "—"}</td><td style={printTd}>Overall Condition</td><td style={printTd}>{humanize(detail.overallCondition)}</td></tr>
                  </tbody>
                </table>
                <div style={{ fontSize: 13, fontWeight: 700, margin: "8px 0 4px" }}>Findings</div>
                {detail.findings.length === 0 ? (
                  <div style={{ fontSize: 12 }}>No findings recorded.</div>
                ) : (
                  <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={printTh}>#</th>
                        <th style={printThLeft}>Finding</th>
                        <th style={printTh}>Severity</th>
                        <th style={printThLeft}>Recommendation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.findings.map((f, i) => (
                        <tr key={f.id}>
                          <td style={printTd}>{i + 1}</td>
                          <td style={printTdLeft}>{f.finding}</td>
                          <td style={printTd}>{humanize(f.severity)}</td>
                          <td style={printTdLeft}>{f.recommendation || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div style={{ fontSize: 13, fontWeight: 700, margin: "12px 0 4px" }}>Summary</div>
                <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{detail.summary || "—"}</div>
                <div style={{ fontSize: 13, fontWeight: 700, margin: "12px 0 4px" }}>Recommendations</div>
                <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{detail.recommendations || "—"}</div>
                <div style={{ marginTop: 32, fontSize: 12, display: "flex", justifyContent: "space-between" }}>
                  <span>Inspector: ______________________</span>
                  <span>Approved by: ______________________</span>
                </div>
              </div>

              <div className="space-y-3 py-1">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <Meta label="Inspection Date" value={fmtDate(detail.inspectionDate)} />
                  <Meta label="Inspector" value={detail.inspector?.user?.name ?? "—"} />
                  <Meta label="Overall Condition" value={<StatusBadge status={detail.overallCondition} />} />
                  <Meta label="Project" value={detail.project ? `${detail.project.code} — ${detail.project.name}` : "—"} />
                  <Meta label="Equipment" value={detail.equipment ? `${detail.equipment.name} (${detail.equipment.assetTag})` : "—"} />
                  <Meta label="Findings" value={String(detail.findings.length)} />
                </div>

                <Separator />

                <div>
                  <div className="text-sm font-medium mb-1.5">Findings</div>
                  {detail.findings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No findings recorded.</p>
                  ) : (
                    <div className="rounded-lg border overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left font-medium p-2.5">Finding</th>
                            <th className="text-left font-medium p-2.5 w-24">Severity</th>
                            <th className="text-left font-medium p-2.5">Recommendation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.findings.map((f) => (
                            <tr key={f.id} className="border-t">
                              <td className="p-2.5">{f.finding}</td>
                              <td className="p-2.5"><StatusBadge status={f.severity} /></td>
                              <td className="p-2.5 text-muted-foreground">{f.recommendation || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-sm font-medium mb-1">Summary</div>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{detail.summary || "—"}</p>
                </div>
                <div>
                  <div className="text-sm font-medium mb-1">Recommendations</div>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{detail.recommendations || "—"}</p>
                </div>
              </div>

              <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-between gap-2">
                <div>
                  {detail.status === "DRAFT" && canManage ? (
                    <Button variant="ghost" size="sm" disabled={busyId === detail.id} onClick={() => void deleteReport(detail)}>
                      <Trash2 className="h-4 w-4 mr-1.5 text-red-600" /> Delete Draft
                    </Button>
                  ) : (
                    <span />
                  )}
                </div>
                <div className="flex flex-wrap gap-2 justify-end">
                  <Button variant="outline" size="sm" onClick={() => window.print()}>
                    <Printer className="h-4 w-4 mr-1.5" /> Print
                  </Button>
                  {detail.status === "DRAFT" ? (
                    <Button size="sm" disabled={busyId === detail.id} onClick={() => void transitionReport(detail, "submit")}>
                      <Send className="h-4 w-4 mr-1.5" /> {busyId === detail.id ? "Submitting…" : "Submit for Approval"}
                    </Button>
                  ) : null}
                  {detail.status === "SUBMITTED" && canManage ? (
                    <Button size="sm" disabled={busyId === detail.id} onClick={() => void transitionReport(detail, "approve")}>
                      <CheckCheck className="h-4 w-4 mr-1.5" /> {busyId === detail.id ? "Approving…" : "Approve"}
                    </Button>
                  ) : null}
                </div>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium mt-0.5">{value}</div>
    </div>
  );
}

// Print scoping: when printing, show only the print document (component-local,
// no changes to shared globals.css required).
const printCss = (
  <style>{`
    @media print {
      body * { visibility: hidden !important; }
      #irms-print-doc, #irms-print-doc * { visibility: visible !important; }
      #irms-print-doc {
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        width: 100% !important;
        padding: 24px !important;
        background: #fff !important;
        color: #000 !important;
      }
    }
  `}</style>
);

const printTd: CSSProperties = { border: "1px solid #999", padding: "6px 8px", fontWeight: 600, fontSize: 11 };
const printTdLeft: CSSProperties = { border: "1px solid #999", padding: "6px 8px", fontSize: 12 };
const printTh: CSSProperties = { border: "1px solid #999", padding: "6px 8px", background: "#eee", textAlign: "center", fontSize: 11 };
const printThLeft: CSSProperties = { border: "1px solid #999", padding: "6px 8px", background: "#eee", textAlign: "left", fontSize: 11 };
