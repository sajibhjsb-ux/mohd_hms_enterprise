"use client";

// Audit module — server-filtered audit trail (action, actor email, date range)
// with incremental loading, client-side table controls and CSV export.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDateTime } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AuditItem = {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: unknown;
  ip: string;
  createdAt: string;
};

type Filters = { action: string; actorEmail: string; from: string; to: string };
const EMPTY_FILTERS: Filters = { action: "", actorEmail: "", from: "", to: "" };
const PAGE_SIZE = 200; // server cap — "Load more" appends the next page

function metadataSummary(m: unknown): string {
  if (m === null || m === undefined || m === "") return "";
  let text: string;
  if (typeof m === "string") text = m;
  else if (typeof m === "object") {
    try {
      text = JSON.stringify(m);
    } catch {
      text = String(m);
    }
  } else text = String(m);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function AuditModule() {
  const { toast } = useToast();

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);

  const [rows, setRows] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (targetPage: number, f: Filters, append: boolean) => {
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await api.get<AuditItem[]>(`/api/v1/audit-logs${qs({ ...f, page: targetPage, pageSize: PAGE_SIZE })}`);
        const serverTotal = Number(res.meta?.total ?? res.data.length);
        setTotal(serverTotal);
        setRows((prev) => (append ? [...prev, ...res.data] : res.data));
        setPage(targetPage);
      } catch (e) {
        if (!append) setError(e instanceof Error ? e.message : "Unable to load audit logs.");
        else {
          toast({ title: "Could not load more entries", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
        }
      } finally {
        setLoadingMore(false);
        setLoading(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    void loadPage(1, applied, false);
  }, [applied, loadPage]);

  const applyFilters = () => setApplied({ ...filters });

  const resetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  };

  const hasMore = rows.length < total;

  const columns: Column<AuditItem>[] = [
    {
      key: "createdAt",
      header: "Time",
      value: (r) => r.createdAt,
      render: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</span>,
    },
    {
      key: "actorEmail",
      header: "Actor",
      value: (r) => r.actorEmail,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate">{r.actorEmail || "—"}</div>
          {r.actorName ? <div className="text-xs text-muted-foreground truncate">{r.actorName}</div> : null}
        </div>
      ),
    },
    {
      key: "action",
      header: "Action",
      value: (r) => r.action,
      render: (r) => <span className="font-mono text-xs">{r.action}</span>,
    },
    {
      key: "resource",
      header: "Resource",
      value: (r) => `${r.resourceType} ${r.resourceId}`,
      render: (r) => (
        <div className="min-w-0">
          <div>{r.resourceType || "—"}</div>
          {r.resourceId ? <div className="text-xs text-muted-foreground truncate font-mono">{r.resourceId}</div> : null}
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: "metadata",
      header: "Metadata",
      value: (r) => metadataSummary(r.metadata),
      render: (r) => {
        const summary = metadataSummary(r.metadata);
        return summary ? (
          <span className="text-xs text-muted-foreground font-mono break-all">{summary}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
      hideOnMobile: true,
    },
    {
      key: "ip",
      header: "IP",
      value: (r) => r.ip,
      render: (r) => r.ip || <span className="text-muted-foreground">—</span>,
      hideOnMobile: true,
    },
  ];

  return (
    <div>
      <PageHeader title="Audit Logs" subtitle="Immutable trail of every privileged action in the system" />

      {/* Server-side filters */}
      <div className="rounded-xl border bg-card p-4 mb-5 no-print">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="audit-action">Action contains</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
              <Input
                id="audit-action"
                className="pl-8"
                placeholder="e.g. VEHICLE"
                value={filters.action}
                onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-actor">Actor email contains</Label>
            <Input
              id="audit-actor"
              placeholder="e.g. admin@"
              value={filters.actorEmail}
              onChange={(e) => setFilters((f) => ({ ...f, actorEmail: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-from">From</Label>
            <Input
              id="audit-from"
              type="date"
              value={filters.from}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-to">To</Label>
            <Input
              id="audit-to"
              type="date"
              value={filters.to}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button size="sm" onClick={applyFilters} className="flex-1">Apply</Button>
            <Button size="sm" variant="outline" onClick={resetFilters}>Reset</Button>
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingState label="Loading audit trail…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void loadPage(1, applied, false)} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No audit entries match"
          hint="Try widening the date range or clearing the action / actor filters."
        />
      ) : (
        <div className="space-y-3">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            searchPlaceholder="Search loaded entries…"
            emptyTitle="No audit entries"
            exportName="audit-logs"
          />
          {hasMore ? (
            <div className="flex items-center justify-center gap-3 no-print">
              <span className="text-sm text-muted-foreground">
                Showing {rows.length} of {total} entries
              </span>
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadPage(page + 1, applied, true)}>
                {loadingMore ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Loading…
                  </>
                ) : (
                  "Load more"
                )}
              </Button>
            </div>
          ) : (
            <div className="text-center text-sm text-muted-foreground no-print">
              Showing all {total} entr{total === 1 ? "y" : "ies"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
