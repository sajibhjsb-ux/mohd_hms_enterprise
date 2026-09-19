"use client";

// MOHD.HMS ENTERPRISE — IRMS reports list (server-paginated, spec §47).
//
// NEVER loads all rows: state {page, pageSize=20, search, status[], projectId,
// inspectorId, type, priority, overdue, mine} is sent to
// GET /api/v1/irms/reports and the server returns one page + pagedMeta.
// Initial filters arrive from the hash query (KPI drill-down, contract
// FRONTEND CONTRACT); DrilldownChips removal navigates via
// navigateTo("irms", ["reports"], nextParams) — NOT useModuleQuery.apply
// (it would drop the "reports" segment). Desktop renders a real table;
// mobile renders stacked cards (375px, no horizontal overflow).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Loader2, Plus, Search, X } from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate } from "@/lib/hms/format";
import { useRealtimeEventDebounced } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { humanize, IRMS_STATUSES, PRIORITIES, PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useModuleQuery } from "@/lib/hms/page-query";
import { IrmsSectionNav } from "./irms-dashboard";
import {
  DrilldownChips, EmptyState, ErrorState, LoadingState, PageHeader, PriorityBadge, StatusBadge, type DrilldownChip,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// ── Types ──

export type IrmsReportRow = {
  id: string;
  code: string;
  title: string;
  type: string;
  priority?: string | null;
  status: string;
  inspectionDate: string;
  completionPercent?: number | null;
  project: { id: string; code: string; name: string; customerId: string; customer?: { companyName: string } | null } | null;
  equipment: { id: string; name: string; assetTag: string } | null;
  inspector: { id: string; employeeNo?: string; user?: { id?: string; name?: string | null } | null } | null;
  workOrder: { id: string; code: string } | null;
  _count?: { photos: number; findings: number };
};

const REPORT_TYPES = ["ROUTINE", "SAFETY", "EQUIPMENT", "PROJECT", "OTHER"];
const PAGE_SIZE = 20;

type Filters = {
  search: string;
  status: string[];
  projectId: string;
  inspectorId: string;
  type: string;
  priority: string;
  overdue: boolean;
  mine: boolean;
};

const EMPTY: Filters = { search: "", status: [], projectId: "", inspectorId: "", type: "", priority: "", overdue: false, mine: false };

function filtersFromParams(p: Record<string, string>): Filters {
  return {
    ...EMPTY,
    search: p.search ?? "",
    status: p.status ? p.status.split(",").map((s) => s.trim().toUpperCase()).filter((s) => (IRMS_STATUSES as readonly string[]).includes(s)) : [],
    projectId: p.projectId ?? "",
    inspectorId: p.inspectorId ?? "",
    type: p.type && REPORT_TYPES.includes(p.type) ? p.type : "",
    priority: p.priority && (PRIORITIES as readonly string[]).includes(p.priority) ? p.priority : "",
    overdue: p.overdue === "1",
    mine: p.mine === "1",
  };
}

// ── Component ──

export function IrmsReportsList() {
  const { user } = useSession();
  const canCreate = hasPerm(user, PERMISSIONS.irms_create);

  const moduleQuery = useModuleQuery("irms");
  const rawQuery = moduleQuery.raw;

  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(moduleQuery.params));
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<IrmsReportRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Meta (projects for the filter select + chip labels)
  const [projects, setProjects] = useState<{ id: string; code: string; name: string }[] | null>(null);

  // Debounced search input
  const [searchInput, setSearchInput] = useState(filters.search);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // URL query → filters (chip removal / drill-down navigation re-applies here).
  useEffect(() => {
    setFilters(filtersFromParams(moduleQuery.params));
    setSearchInput(moduleQuery.params.search ?? "");
    setPage(1);
     
  }, [rawQuery]);

  // Debounce search input into filters (400ms).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFilters((f) => (f.search === searchInput ? f : { ...f, search: searchInput }));
      setPage(1);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  useEffect(() => {
    let alive = true;
    api.get<{ id: string; code: string; name: string }[]>("/api/v1/irms/meta")
      .then((r) => { if (alive) setProjects((r.data as unknown as { projects?: { id: string; code: string; name: string }[] })?.projects ?? null); })
      .catch(() => { if (alive) setProjects(null); });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<IrmsReportRow[]>(`/api/v1/irms/reports${qs({
        page,
        pageSize: PAGE_SIZE,
        search: filters.search || undefined,
        status: filters.status.length ? filters.status.join(",") : undefined,
        projectId: filters.projectId || undefined,
        inspectorId: filters.inspectorId || undefined,
        type: filters.type || undefined,
        priority: filters.priority || undefined,
        overdue: filters.overdue ? "1" : undefined,
        mine: filters.mine ? "1" : undefined,
      })}`);
      setRows(res.data ?? []);
      setTotal(Number(res.meta?.total ?? (res.data as unknown[])?.length ?? 0));
      setTotalPages(Math.max(1, Number(res.meta?.totalPages ?? 1)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load inspection reports.");
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => { load(); }, [load]);

  useRealtimeEventDebounced(MODULE_EVENTS.irms, () => { void load(); });

  // ── Chip navigation (keeps the "reports" segment) ──
  const navigateWithParams = (next: Record<string, string | undefined>) => {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (v !== undefined && v !== "") cleaned[k] = v;
    }
    navigateTo("irms", ["reports"], Object.keys(cleaned).length ? cleaned : undefined);
  };

  const removeChip = (key: string) => {
    const next: Record<string, string | undefined> = { ...moduleQuery.params };
    delete next[key];
    navigateWithParams(next);
  };

  const chips = useMemo<DrilldownChip[]>(() => {
    const p = moduleQuery.params;
    const out: DrilldownChip[] = [];
    if (p.status) out.push({ key: "status", label: "Status", value: p.status.split(",").map((s) => humanize(s.trim())).join(", ") });
    if (p.overdue === "1") out.push({ key: "overdue", label: "Scope", value: "Overdue only" });
    if (p.projectId) {
      const proj = projects?.find((x) => x.id === p.projectId);
      out.push({ key: "projectId", label: "Project", value: proj ? proj.code : p.projectId.slice(0, 8) });
    }
    if (p.priority) out.push({ key: "priority", label: "Priority", value: humanize(p.priority) });
    if (p.type) out.push({ key: "type", label: "Type", value: humanize(p.type) });
    if (p.mine === "1") out.push({ key: "mine", label: "Scope", value: "My reports" });
    return out;
  }, [moduleQuery.params, projects]);

  const activeFilterCount =
    (filters.status.length > 0 ? 1 : 0) + (filters.projectId ? 1 : 0) + (filters.type ? 1 : 0) +
    (filters.priority ? 1 : 0) + (filters.overdue ? 1 : 0) + (filters.mine ? 1 : 0);

  const toggleStatus = (s: string) => {
    setFilters((f) => ({
      ...f,
      status: f.status.includes(s) ? f.status.filter((x) => x !== s) : [...f.status, s],
    }));
    setPage(1);
  };

  const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);

  return (
    <div>
      <PageHeader
        title="Inspection Reports"
        subtitle="Server-paginated list — filter by status, project, type, priority, overdue or inspector"
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => navigateTo("irms", ["reports", "new"])}>
              <Plus className="h-4 w-4 mr-1.5" /> New Report
            </Button>
          ) : null
        }
      />

      <IrmsSectionNav active="reports" />

      <DrilldownChips chips={chips} onRemove={removeChip} onClear={() => navigateTo("irms", ["reports"])} />

      {/* Filter bar */}
      <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search code, title, project…"
            aria-label="Search inspection reports"
            className="pl-8"
          />
        </div>

        {/* Status multi-select */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="justify-between font-normal" aria-label={`Filter by status, ${filters.status.length} selected`}>
              <span className="truncate">
                {filters.status.length === 0 ? "All statuses" : filters.status.length === 1 ? humanize(filters.status[0]) : `${filters.status.length} statuses`}
              </span>
              <ChevronDown className="h-4 w-4 opacity-50" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-0" align="start">
            <Command>
              <CommandList>
                <CommandEmpty>No status found.</CommandEmpty>
                <CommandGroup>
                  {IRMS_STATUSES.map((s) => (
                    <CommandItem key={s} onSelect={() => toggleStatus(s)} className="gap-2">
                      <span className={cn("flex h-4 w-4 items-center justify-center rounded-sm border", filters.status.includes(s) ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40")}>
                        {filters.status.includes(s) ? <Check className="h-3 w-3" aria-hidden /> : null}
                      </span>
                      {humanize(s)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {/* Project select */}
        <Select
          value={filters.projectId || "ALL"}
          onValueChange={(v) => { setFilters((f) => ({ ...f, projectId: v === "ALL" ? "" : v })); setPage(1); }}
        >
          <SelectTrigger aria-label="Filter by project"><SelectValue placeholder="All projects" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All projects</SelectItem>
            {(projects ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Priority select */}
        <Select
          value={filters.priority || "ALL"}
          onValueChange={(v) => { setFilters((f) => ({ ...f, priority: v === "ALL" ? "" : v })); setPage(1); }}
        >
          <SelectTrigger aria-label="Filter by priority"><SelectValue placeholder="All priorities" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All priorities</SelectItem>
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Type select */}
        <Select
          value={filters.type || "ALL"}
          onValueChange={(v) => { setFilters((f) => ({ ...f, type: v === "ALL" ? "" : v })); setPage(1); }}
        >
          <SelectTrigger aria-label="Filter by type"><SelectValue placeholder="All types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All types</SelectItem>
            {REPORT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Overdue + Mine switches */}
        <div className="flex items-center gap-4 sm:col-span-2 lg:col-span-4 xl:col-span-6">
          <div className="flex items-center gap-2">
            <Switch
              id="irms-overdue-only"
              checked={filters.overdue}
              onCheckedChange={(v) => { setFilters((f) => ({ ...f, overdue: v })); setPage(1); }}
            />
            <Label htmlFor="irms-overdue-only" className="text-sm">Overdue only</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="irms-mine-only"
              checked={filters.mine}
              onCheckedChange={(v) => { setFilters((f) => ({ ...f, mine: v })); setPage(1); }}
            />
            <Label htmlFor="irms-mine-only" className="text-sm">My reports</Label>
          </div>
          {activeFilterCount > 0 ? (
            <Button
              variant="ghost" size="sm" className="ml-auto text-muted-foreground"
              onClick={() => { setFilters((f) => ({ ...f, status: [], projectId: "", type: "", priority: "", overdue: false, mine: false })); setPage(1); }}
            >
              <X className="h-4 w-4 mr-1" /> Reset filters
            </Button>
          ) : null}
        </div>
      </div>

      {/* Data */}
      {loading && rows === null ? (
        <LoadingState label="Loading inspection reports…" rows={5} />
      ) : error && rows === null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState
          title="No inspection reports match"
          hint={filters.search || activeFilterCount > 0 ? "Try adjusting the search or filters." : "Reports created here will appear in this list."}
          action={canCreate && !filters.search && activeFilterCount === 0 ? (
            <Button size="sm" onClick={() => navigateTo("irms", ["reports", "new"])}><FileText className="h-4 w-4 mr-1.5" /> New Report</Button>
          ) : undefined}
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3 font-medium">Code</th>
                  <th className="p-3 font-medium">Title</th>
                  <th className="p-3 font-medium">Project</th>
                  <th className="p-3 font-medium">Type</th>
                  <th className="p-3 font-medium">Priority</th>
                  <th className="p-3 font-medium">Inspector</th>
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">Completion</th>
                  <th className="p-3 font-medium">Photos</th>
                  <th className="p-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => navigateTo("irms", ["reports", r.id])}
                    className="cursor-pointer border-t transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") navigateTo("irms", ["reports", r.id]); }}
                    aria-label={`Open report ${r.code}`}
                  >
                    <td className="whitespace-nowrap p-3 font-medium">{r.code}</td>
                    <td className="max-w-[240px] truncate p-3" title={r.title}>{r.title}</td>
                    <td className="max-w-[180px] truncate p-3">{r.project?.name ?? "—"}</td>
                    <td className="whitespace-nowrap p-3">{humanize(r.type)}</td>
                    <td className="p-3"><PriorityBadge priority={r.priority} /></td>
                    <td className="whitespace-nowrap p-3">{r.inspector?.user?.name ?? "—"}</td>
                    <td className="whitespace-nowrap p-3">{fmtDate(r.inspectionDate)}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, r.completionPercent ?? 0))}%` }} />
                        </div>
                        <span className="tabular-nums text-muted-foreground">{r.completionPercent ?? 0}%</span>
                      </div>
                    </td>
                    <td className="p-3 tabular-nums">{r._count?.photos ?? 0}</td>
                    <td className="p-3"><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-2 md:hidden">
            {rows.map((r) => (
              <li key={r.id}>
                <a
                  href={`/irms/reports/${r.id}`}
                  className="block rounded-xl border bg-card p-3.5 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Open report ${r.code} — ${r.title}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{r.code}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <p className="mt-1 text-sm">{r.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {r.project?.name ?? "No project"} · {fmtDate(r.inspectionDate)}
                  </p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <PriorityBadge priority={r.priority} />
                    <span>{humanize(r.type)}</span>
                    <span className="tabular-nums">{r.completionPercent ?? 0}% · {r._count?.photos ?? 0} photos</span>
                  </div>
                </a>
              </li>
            ))}
          </ul>

          {/* Pagination */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground tabular-nums">
              {total > 0 ? `Showing ${start}–${end} of ${total}` : "No rows"} · Page {page} of {totalPages}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" /> Prev
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {loading && rows !== null ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Refreshing…
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
