"use client";

// MOHD.HMS ENTERPRISE — Work Orders module (list page).
// PENDING → ACCEPTED → IN_PROGRESS → COMPLETED (+ ON_HOLD, CANCELLED).
//
// NAVIGATION ARCHITECTURE: work order create / detail are DEDICATED PAGES
// routed by the hash router (ui-store pages["work-orders"]):
//   []        → this list page
//   ["new"]   → WorkOrderNewPage
//   [id]      → WorkOrderDetailPage
// No business dialogs remain — the only dialog in the module is the cancel
// AlertDialog on the detail page.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  PageHeader, StatCard, StatusBadge, PriorityBadge, LoadingState, EmptyState, ErrorState, DrilldownChips,
} from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, PRIORITIES, humanize } from "@/lib/hms/constants";
import { useModuleQuery } from "@/lib/hms/page-query";
import { money, fmtDate } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import {
  CircleDollarSign, ClipboardList, Hammer, PauseCircle, PlayCircle, Plus, Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkOrderNewPage } from "./new-page";
import { WorkOrderDetailPage } from "./detail-page";

// ── Types ──

type WORow = {
  id: string;
  code: string;
  title: string;
  status: string;
  priority: string;
  scheduledDate: string | null;
  totalCents: number;
  createdAt: string;
  customer?: { id: string; companyName: string } | null;
  equipment?: { id: string; name: string; assetTag: string } | null;
  technician?: { id: string; user?: { id: string; name: string } | null } | null;
  complaint?: { id: string; code: string } | null;
};

const PENDING_STATUSES = ["PENDING", "ACCEPTED"];
/** Not yet finished — matches the dashboard "Active Work Orders" KPI exactly
 *  (PENDING | ACCEPTED | IN_PROGRESS | ON_HOLD). */
const ACTIVE_STATUSES = ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"];

const STATUS_TABS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "ALL", label: "All", match: () => true },
  { key: "ACTIVE", label: "Active", match: (s) => ACTIVE_STATUSES.includes(s) },
  { key: "PENDING", label: "Pending", match: (s) => PENDING_STATUSES.includes(s) },
  { key: "IN_PROGRESS", label: "In Progress", match: (s) => s === "IN_PROGRESS" },
  { key: "ON_HOLD", label: "On Hold", match: (s) => s === "ON_HOLD" },
  { key: "COMPLETED", label: "Completed", match: (s) => s === "COMPLETED" },
  { key: "CANCELLED", label: "Cancelled", match: (s) => s === "CANCELLED" },
];

// ── Module router ──

export function WorkOrdersModule() {
  const seg = useUi((s) => s.pages["work-orders"]) ?? [];
  const query = useUi((s) => s.queries["work-orders"] ?? "");
  const page = pageFromSeg(seg);

  if (page.view === "new") return <WorkOrderNewPage />;
  if (page.view === "detail" && page.id) return <WorkOrderDetailPage id={page.id} />;
  // key={query}: a new drill-down URL (KPI click / direct link) remounts the
  // list with the query applied as its initial filter state.
  return <WorkOrdersList key={query} />;
}

// ── List page ──

function WorkOrdersList() {
  const { user } = useSession();
  const canCreate = hasPerm(user, PERMISSIONS.work_orders_create);

  // KPI drill-down (e.g. #/work-orders?status=active): validated case-insensitively
  // against the canonical tab keys, then applied once on mount.
  const dq = useModuleQuery("work-orders");
  const statusTab = STATUS_TABS.find((t) => t.key === dq.params.status?.toUpperCase());
  const statusParam = statusTab?.key;

  // All page navigation flows through the hash router (URL + Back/Forward).
  const openPage = useCallback((seg: string[]) => navigateTo("work-orders", seg), []);

  // ── List state ──
  const [rows, setRows] = useState<WORow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(statusParam ?? "ALL");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<WORow[]>(`/api/v1/work-orders${qs({ pageSize: 200 })}`);
      setRows(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load work orders.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Derived views ──
  const stats = useMemo(() => {
    const list = rows ?? [];
    const count = (match: (r: WORow) => boolean) => list.filter(match).length;
    return {
      total: list.length,
      pending: count((r) => PENDING_STATUSES.includes(r.status)),
      inProgress: count((r) => r.status === "IN_PROGRESS"),
      onHold: count((r) => r.status === "ON_HOLD"),
      completed: count((r) => r.status === "COMPLETED"),
      valueCents: list.filter((r) => !["CANCELLED"].includes(r.status)).reduce((s, r) => s + (r.totalCents ?? 0), 0),
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

  const columns: Column<WORow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, className: "font-mono text-xs whitespace-nowrap" },
    { key: "title", header: "Title", value: (r) => r.title, className: "max-w-[240px] truncate" },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} />, value: (r) => r.status },
    { key: "priority", header: "Priority", render: (r) => <PriorityBadge priority={r.priority} />, value: (r) => r.priority, hideOnMobile: true },
    { key: "customer", header: "Customer", value: (r) => r.customer?.companyName ?? "", hideOnMobile: true },
    { key: "technician", header: "Technician", value: (r) => r.technician?.user?.name ?? "", render: (r) => r.technician?.user?.name ?? "—" },
    { key: "scheduledDate", header: "Scheduled", value: (r) => r.scheduledDate ?? "", render: (r) => fmtDate(r.scheduledDate), hideOnMobile: true },
    { key: "totalCents", header: "Total", value: (r) => r.totalCents, render: (r) => money(r.totalCents), className: "tabular-nums whitespace-nowrap" },
  ];

  return (
    <div>
      <PageHeader
        title="Work Orders"
        subtitle="Execution cockpit: assignments, checklists, materials and costs."
        actions={canCreate ? (
          <Button onClick={() => openPage(["new"])}>
            <Plus className="h-4 w-4 mr-1.5" /> New Work Order
          </Button>
        ) : null}
      />

      <DrilldownChips
        chips={statusParam && statusParam !== "ALL" ? [{ key: "status", label: "Status", value: humanize(statusParam) }] : []}
        onRemove={(key) => dq.apply({ [key]: undefined })}
        onClear={dq.clear}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <StatCard title="Total" value={stats.total} icon={<ClipboardList className="h-5 w-5" />} loading={!rows && loading} />
        <StatCard title="Pending" value={stats.pending} icon={<PlayCircle className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="In Progress" value={stats.inProgress} icon={<Wrench className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="On Hold" value={stats.onHold} icon={<PauseCircle className="h-5 w-5" />} tone="danger" loading={!rows && loading} />
        <StatCard title="Completed" value={stats.completed} icon={<Hammer className="h-5 w-5" />} tone="success" loading={!rows && loading} />
        <StatCard title="Total Value" value={money(stats.valueCents)} icon={<CircleDollarSign className="h-5 w-5" />} loading={!rows && loading} />
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
        <LoadingState label="Loading work orders…" rows={5} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          title="No work orders in this view"
          hint={canCreate ? "Create a work order to dispatch a technician." : "Work orders will appear here when the team creates them."}
          action={canCreate ? <Button variant="outline" onClick={() => openPage(["new"])}><Plus className="h-4 w-4 mr-1.5" /> New Work Order</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={visibleRows}
          rowKey={(r) => r.id}
          onRowClick={(r) => openPage([r.id])}
          searchPlaceholder="Search code or title…"
          filters={[{
            key: "priority",
            label: "Priorities",
            options: PRIORITIES.map((p) => ({ value: p, label: humanize(p) })),
            match: (row, value) => row.priority === value,
          }]}
          emptyTitle="No work orders match"
          exportName="work-orders"
        />
      )}
    </div>
  );
}
