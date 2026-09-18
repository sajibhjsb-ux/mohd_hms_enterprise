"use client";

// MOHD.HMS ENTERPRISE — Complaints module (list page).
// Customer portal + staff workflow: NEW → ASSIGNED → IN_PROGRESS → COMPLETED →
// CONFIRMED → CLOSED (+ CANCELLED). Role-gated actions, live status timeline.
//
// NAVIGATION ARCHITECTURE: complaint create / detail / assign are DEDICATED
// PAGES routed by the hash router (ui-store pages["complaints"]):
//   []                  → this list page
//   ["new"]             → ComplaintNewPage
//   [id]                → ComplaintDetailPage
//   [id, "assign"]      → ComplaintAssignPage

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  PageHeader, StatCard, StatusBadge, PriorityBadge, LoadingState, EmptyState, ErrorState, DrilldownChips,
} from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, PRIORITIES, humanize } from "@/lib/hms/constants";
import { useModuleQuery } from "@/lib/hms/page-query";
import { fmtDate } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle, CheckCircle2, ClipboardCheck, Clock, Hammer, ListChecks, Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ComplaintNewPage } from "./new-page";
import { ComplaintEditPage } from "./edit-page";
import { ComplaintDetailPage } from "./detail-page";
import { ComplaintAssignPage } from "./assign-page";

// ── Types ──

type ComplaintRow = {
  id: string;
  code: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  createdAt: string;
  customerId: string;
  customer?: { id: string; companyName: string } | null;
  equipment?: { id: string; name: string; assetTag: string } | null;
  assignedTechnician?: { id: string; user?: { id: string; name: string } | null } | null;
};

const OPEN_STATUSES = ["NEW", "ASSIGNED"];
const PROGRESS_STATUSES = ["IN_PROGRESS"];
const RESOLVED_STATUSES = ["COMPLETED", "CONFIRMED"];
/** Active = everything not yet resolved/closed/cancelled — matches the
 *  dashboard "Open Complaints" KPI exactly (NEW | ASSIGNED | IN_PROGRESS). */
const ACTIVE_STATUSES = ["NEW", "ASSIGNED", "IN_PROGRESS"];

const STATUS_TABS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "ALL", label: "All", match: () => true },
  { key: "ACTIVE", label: "Active", match: (s) => ACTIVE_STATUSES.includes(s) },
  { key: "OPEN", label: "Open", match: (s) => OPEN_STATUSES.includes(s) },
  { key: "IN_PROGRESS", label: "In Progress", match: (s) => PROGRESS_STATUSES.includes(s) },
  { key: "RESOLVED", label: "Resolved", match: (s) => RESOLVED_STATUSES.includes(s) },
  { key: "CLOSED", label: "Closed", match: (s) => s === "CLOSED" },
  { key: "CANCELLED", label: "Cancelled", match: (s) => s === "CANCELLED" },
];

// ── Module router ──

export function ComplaintsModule() {
  const seg = useUi((s) => s.pages["complaints"]) ?? [];
  const query = useUi((s) => s.queries["complaints"] ?? "");
  const page = pageFromSeg(seg);

  if (page.view === "new") return <ComplaintNewPage />;
  if (page.view === "assign" && page.id) return <ComplaintAssignPage id={page.id} />;
  if (page.view === "edit" && page.id) return <ComplaintEditPage id={page.id} />;
  if (page.view === "detail" && page.id) return <ComplaintDetailPage id={page.id} />;
  // key={query}: a new drill-down URL (KPI click / direct link) remounts the
  // list with the query applied as its initial filter state.
  return <ComplaintsList key={query} />;
}

// ── List page ──

function ComplaintsList() {
  const { user } = useSession();
  const canCreate = hasPerm(user, PERMISSIONS.complaints_create);
  const isStaffUser = !!user && user.role !== "CUSTOMER";

  // KPI drill-down (e.g. #/complaints?status=active&priority=URGENT): validated
  // case-insensitively against the canonical tab keys / priority values, then
  // applied once on mount.
  const dq = useModuleQuery("complaints");
  const statusTab = STATUS_TABS.find((t) => t.key === dq.params.status?.toUpperCase());
  const statusParam = statusTab?.key;
  const priorityParam = PRIORITIES.find((p) => p === dq.params.priority?.toUpperCase());

  // All page navigation flows through the hash router (URL + Back/Forward).
  const openPage = useCallback((seg: string[]) => navigateTo("complaints", seg), []);

  // ── List state ──
  const [rows, setRows] = useState<ComplaintRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(statusParam ?? "ALL");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<ComplaintRow[]>(`/api/v1/complaints${qs({ pageSize: 200 })}`);
      setRows(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load complaints.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, reloadKey]);

  // Realtime (STEP 38-42): complaint lifecycle events refresh the list live.
  useRealtimeEvent(MODULE_EVENTS.complaints, () => setReloadKey((k) => k + 1));

  // ── Derived views ──
  const stats = useMemo(() => {
    const list = rows ?? [];
    const count = (match: (r: ComplaintRow) => boolean) => list.filter(match).length;
    return {
      total: list.length,
      open: count((r) => OPEN_STATUSES.includes(r.status)),
      inProgress: count((r) => PROGRESS_STATUSES.includes(r.status)),
      resolved: count((r) => RESOLVED_STATUSES.includes(r.status)),
      closed: count((r) => r.status === "CLOSED"),
      urgent: count((r) => r.priority === "URGENT" && !["CLOSED", "CANCELLED"].includes(r.status)),
    };
  }, [rows]);

  const visibleRows = useMemo(() => {
    const active = STATUS_TABS.find((t) => t.key === tab) ?? STATUS_TABS[0];
    return (rows ?? []).filter((r) => active.match(r.status));
  }, [rows, tab]);

  const tabCount = (key: string) => {
    const active = STATUS_TABS.find((t) => t.key === key);
    if (!active) return 0;
    return (rows ?? []).filter((r) => active.match(r.status)).length;
  };

  const columns: Column<ComplaintRow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, className: "font-mono text-xs whitespace-nowrap" },
    { key: "title", header: "Title", value: (r) => r.title, className: "max-w-[260px] truncate" },
    { key: "priority", header: "Priority", render: (r) => <PriorityBadge priority={r.priority} />, value: (r) => r.priority },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} />, value: (r) => r.status },
    { key: "customer", header: "Customer", value: (r) => r.customer?.companyName ?? "", hideOnMobile: true },
    { key: "technician", header: "Technician", value: (r) => r.assignedTechnician?.user?.name ?? "", render: (r) => r.assignedTechnician?.user?.name ?? "—", hideOnMobile: true },
    { key: "equipment", header: "Equipment", value: (r) => r.equipment?.name ?? "", render: (r) => (r.equipment ? `${r.equipment.name} (${r.equipment.assetTag})` : "—"), hideOnMobile: true },
    { key: "createdAt", header: "Created", value: (r) => r.createdAt, render: (r) => fmtDate(r.createdAt), hideOnMobile: true },
  ];

  return (
    <div>
      <PageHeader
        title="Complaints"
        subtitle={isStaffUser ? "Track, assign and resolve customer complaints end-to-end." : "Your complaints and their live progress."}
        actions={canCreate ? (
          <Button onClick={() => openPage(["new"])}>
            <Plus className="h-4 w-4 mr-1.5" /> New Complaint
          </Button>
        ) : null}
      />

      <DrilldownChips
        chips={[
          ...(statusParam && statusParam !== "ALL" ? [{ key: "status", label: "Status", value: humanize(statusParam) }] : []),
          ...(priorityParam ? [{ key: "priority", label: "Priority", value: humanize(priorityParam) }] : []),
        ]}
        onRemove={(key) => dq.apply({ [key]: undefined })}
        onClear={dq.clear}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <StatCard title="Total" value={stats.total} icon={<ListChecks className="h-5 w-5" />} loading={!rows && loading} />
        <StatCard title="Open" value={stats.open} icon={<Clock className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="In Progress" value={stats.inProgress} icon={<Hammer className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="Resolved" value={stats.resolved} icon={<CheckCircle2 className="h-5 w-5" />} tone="success" loading={!rows && loading} />
        <StatCard title="Closed" value={stats.closed} icon={<ClipboardCheck className="h-5 w-5" />} loading={!rows && loading} />
        <StatCard title="Urgent Active" value={stats.urgent} icon={<AlertTriangle className="h-5 w-5" />} tone="danger" loading={!rows && loading} />
      </div>

      {/* Status tabs */}
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
            {t.label} <span className="opacity-70 tabular-nums">({tabCount(t.key)})</span>
          </button>
        ))}
      </div>

      {loading && !rows ? (
        <LoadingState label="Loading complaints…" rows={5} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          title="No complaints in this view"
          hint={canCreate ? "Log a new complaint to get started — drafts are saved automatically while you type." : "Complaints will appear here as they are filed."}
          action={canCreate ? <Button variant="outline" onClick={() => openPage(["new"])}><Plus className="h-4 w-4 mr-1.5" /> New Complaint</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={visibleRows}
          rowKey={(r) => r.id}
          onRowClick={(r) => openPage([r.id])}
          searchPlaceholder="Search code, title, description…"
          initialFilters={priorityParam ? { priority: priorityParam } : undefined}
          filters={[{
            key: "priority",
            label: "Priorities",
            options: PRIORITIES.map((p) => ({ value: p, label: humanize(p) })),
            match: (row, value) => row.priority === value,
          }]}
          emptyTitle="No complaints match"
          exportName="complaints"
        />
      )}
    </div>
  );
}
