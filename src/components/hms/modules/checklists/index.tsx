"use client";

// MOHD.HMS ENTERPRISE — Checklists module (list + module router).
// AI checklist engine UI: instances list with status tabs + source filters.
// Router:
//   []                   → this list page
//   ["generate"]         → GenerateChecklistPage (AI / template)
//   ["templates"]        → Template library
//   ["generations"]      → AI generation log (checklist.template_manage)
//   [id]                 → ChecklistDetailPage (review / approve)

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, CHECKLIST_SOURCE_TYPES, humanize } from "@/lib/hms/constants";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { Button } from "@/components/ui/button";
import { Sparkles, Layers, History, ListChecks, ClipboardCheck, Clock3, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChecklistDetailPage } from "./detail-page";
import { GenerateChecklistPage } from "./generate-page";
import { TemplatesPage } from "./templates-page";
import { GenerationsPage } from "./generations-page";

export { ChecklistDetailPage, GenerateChecklistPage, TemplatesPage, GenerationsPage };

type ChecklistRow = {
  id: string;
  code: string;
  title: string;
  sourceType: string;
  status: string;
  version: number;
  origin: string;
  createdAt: string;
  workOrder?: { id: string; code: string; title: string; status: string } | null;
  template?: { id: string; name: string; version: number } | null;
};

const STATUS_TABS = [
  { key: "ALL", label: "All", match: () => true },
  { key: "DRAFT", label: "Draft", match: (s: string) => s === "DRAFT" },
  { key: "PENDING_APPROVAL", label: "Pending Approval", match: (s: string) => s === "PENDING_APPROVAL" },
  { key: "ACTIVE", label: "Active", match: (s: string) => s === "ACTIVE" },
  { key: "COMPLETED", label: "Completed", match: (s: string) => s === "COMPLETED" },
  { key: "REJECTED", label: "Rejected", match: (s: string) => s === "REJECTED" },
];

export function ChecklistsModule() {
  const seg = useUi((s) => s.pages["checklists"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "new") return <GenerateChecklistPage />;
  if (page.view === "detail" && page.id === "generate") return <GenerateChecklistPage />;
  if (page.view === "detail" && page.id === "templates") return <TemplatesPage />;
  if (page.view === "detail" && page.id === "generations") return <GenerationsPage />;
  if (page.view === "detail" && page.id) return <ChecklistDetailPage id={page.id} />;
  return <ChecklistsList />;
}

function ChecklistsList() {
  const { user } = useSession();
  const { toast } = useToast();
  const canGenerate = hasPerm(user, PERMISSIONS.checklist_generate);
  const canManageTemplates = hasPerm(user, PERMISSIONS.checklist_template_manage);

  const openPage = useCallback((seg: string[]) => navigateTo("checklists", seg), []);

  const [rows, setRows] = useState<ChecklistRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("ALL");
  const [sourceType, setSourceType] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<ChecklistRow[]>("/api/v1/checklists" + qs({ pageSize: 200, sourceType }));
      setRows(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load checklists.");
    } finally {
      setLoading(false);
    }
  }, [sourceType]);

  useEffect(() => { load(); }, [load, reloadKey]);

  useRealtimeEvent(MODULE_EVENTS.checklists, () => toast({ title: "Checklists updated", description: "Refreshing…" }));

  const stats = useMemo(() => {
    const list = rows ?? [];
    return {
      total: list.length,
      drafts: list.filter((r) => r.status === "DRAFT").length,
      pending: list.filter((r) => r.status === "PENDING_APPROVAL").length,
      active: list.filter((r) => r.status === "ACTIVE").length,
      completed: list.filter((r) => r.status === "COMPLETED").length,
      rejected: list.filter((r) => r.status === "REJECTED").length,
    };
  }, [rows]);

  const visibleRows = useMemo(() => {
    const t = STATUS_TABS.find((x) => x.key === tab) ?? STATUS_TABS[0];
    return (rows ?? []).filter((r) => t.match(r.status));
  }, [rows, tab]);

  const columns: Column<ChecklistRow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, className: "font-mono text-xs whitespace-nowrap" },
    { key: "title", header: "Title", value: (r) => r.title, className: "max-w-[240px] truncate" },
    { key: "sourceType", header: "Source", value: (r) => r.sourceType, render: (r) => <span className="text-xs font-medium">{humanize(r.sourceType)}</span> },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} />, value: (r) => r.status },
    { key: "origin", header: "Origin", value: (r) => r.origin, render: (r) => <span className="text-xs">{r.origin}</span>, hideOnMobile: true },
    { key: "version", header: "Ver", value: (r) => String(r.version), className: "tabular-nums", hideOnMobile: true },
    { key: "workOrder", header: "Work order", value: (r) => r.workOrder?.code ?? "", render: (r) => r.workOrder?.code ?? "—", hideOnMobile: true },
    { key: "createdAt", header: "Created", value: (r) => r.createdAt, render: (r) => new Date(r.createdAt).toLocaleDateString(), hideOnMobile: true },
  ];

  return (
    <div>
      <PageHeader
        title="Checklists"
        subtitle="AI-drafted, approved and executed inspection checklists across complaints, work orders, PM and IRMS."
        actions={
          <div className="flex flex-wrap gap-2">
            {canManageTemplates ? (
              <Button variant="outline" onClick={() => openPage(["templates"])}>
                <Layers className="h-4 w-4 mr-1.5" /> Templates
              </Button>
            ) : null}
            {canManageTemplates ? (
              <Button variant="outline" onClick={() => openPage(["generations"])}>
                <History className="h-4 w-4 mr-1.5" /> AI Log
              </Button>
            ) : null}
            {canGenerate ? (
              <Button onClick={() => openPage(["generate"])}>
                <Sparkles className="h-4 w-4 mr-1.5" /> Generate
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <StatCard title="Total" value={stats.total} icon={<ListChecks className="h-5 w-5" />} loading={!rows && loading} />
        <StatCard title="Drafts" value={stats.drafts} icon={<Sparkles className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="Pending approval" value={stats.pending} icon={<ClipboardCheck className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="Active" value={stats.active} icon={<Layers className="h-5 w-5" />} tone="success" loading={!rows && loading} />
        <StatCard title="Completed" value={stats.completed} icon={<Clock3 className="h-5 w-5" />} loading={!rows && loading} />
        <StatCard title="Rejected" value={stats.rejected} icon={<Ban className="h-5 w-5" />} tone="danger" loading={!rows && loading} />
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
              tab === t.key ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted text-muted-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="grow" />
        <select
          value={sourceType}
          onChange={(e) => { setSourceType(e.target.value); setTab("ALL"); }}
          className="h-8 rounded-md border bg-background px-2 text-xs"
          aria-label="Filter by source"
        >
          <option value="">All sources</option>
          {CHECKLIST_SOURCE_TYPES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </select>
      </div>

      {loading && !rows ? (
        <LoadingState label="Loading checklists…" rows={5} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          title="No checklists in this view"
          hint={canGenerate ? "Generate a checklist for a complaint, work order, PM plan or IRMS report." : "Checklists will appear here as they are created."}
          action={canGenerate ? <Button onClick={() => openPage(["generate"])}><Sparkles className="h-4 w-4 mr-1.5" /> Generate</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={visibleRows}
          rowKey={(r) => r.id}
          onRowClick={(r) => openPage([r.id])}
          searchPlaceholder="Search code, title…"
          emptyTitle="No checklists match"
          exportName="checklists"
        />
      )}
    </div>
  );
}