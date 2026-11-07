"use client";

// Enterprise data table: client-side search / filter / sort / pagination over a loaded page of data.
import { useMemo, useState, type ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, ChevronRight, ArrowUpDown, Download, Search } from "lucide-react";
import { EmptyState } from "./ui-bits";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  value?: (row: T) => string | number | null | undefined; // sortable/searchable value
  className?: string;
  sortable?: boolean;
  hideOnMobile?: boolean;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  searchPlaceholder?: string;
  filters?: { key: string; label: string; options: { value: string; label: string }[]; match: (row: T, value: string) => boolean }[];
  /** Pre-applied filter values (KPI drill-down); must match `filters` option values. */
  initialFilters?: Record<string, string>;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyHint?: string;
  toolbarExtra?: ReactNode;
  exportName?: string;
  pageSizeDefault?: number;
};

export function DataTable<T>({
  columns, rows, rowKey, searchPlaceholder = "Search…", filters = [], initialFilters, onRowClick,
  emptyTitle = "No records found", emptyHint, toolbarExtra, exportName, pageSizeDefault = 10,
}: Props<T>) {
  const [search, setSearch] = useState("");
  const [filterVals, setFilterVals] = useState<Record<string, string>>(initialFilters ?? {});
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(pageSizeDefault);

  const filtered = useMemo(() => {
    let out = rows;
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((row) =>
        columns.some((c) => {
          const v = c.value ? c.value(row) : null;
          if (v == null) return false;
          return String(v).toLowerCase().includes(q);
        })
      );
    }
    for (const f of filters) {
      const v = filterVals[f.key];
      if (v && v !== "ALL") out = out.filter((row) => f.match(row, v));
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col) {
        const val = col.value ?? ((r: T) => String((r as Record<string, unknown>)[col.key] ?? ""));
        out = [...out].sort((a, b) => {
          const va = val(a) ?? "";
          const vb = val(b) ?? "";
          if (typeof va === "number" && typeof vb === "number") return sortDir === "asc" ? va - vb : vb - va;
          return sortDir === "asc" ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
        });
      }
    }
    return out;
  }, [rows, columns, search, filters, filterVals, sortKey, sortDir]);

  // Mobile card layout: pick the most human-readable column as the title, a
  // reference/code as the subtitle, and surface statuses before the details.
  const mobileColumns = columns.filter((c) => !c.hideOnMobile && c.key !== "actions");
  const titleKeys = ["title", "name", "subject", "supplier", "customer", "companyName", "makeModel", "assetTag", "label", "task", "description", "employee", "project", "action"];
  const metaKeys = ["code", "registrationNo", "sku", "number", "assetTag", "employeeNo", "projectCode"];
  const statusKeys = ["status", "priority", "state", "stockStatus", "severity"];
  const mobileTitle = (mobileColumns.find((c) => titleKeys.includes(c.key)) ?? mobileColumns[0] ?? columns[0])!;
  const mobileMeta = mobileColumns.find((c) => metaKeys.includes(c.key) && c !== mobileTitle);
  const mobileStatus = mobileColumns.filter((c) => statusKeys.includes(c.key));
  const mobileDetails = mobileColumns.filter((c) => c !== mobileTitle && c !== mobileMeta && !mobileStatus.includes(c));
  const mobileActions = columns.find((c) => c.key === "actions");
  const cell = (c: Column<T>, row: T) => c.render ? c.render(row) : String((c.value ? c.value(row) : (row as Record<string, unknown>)[c.key]) ?? "—");

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function exportCsv() {
    const head = columns.map((c) => `"${c.header}"`).join(",");
    const lines = filtered.map((row) => columns.map((c) => {
      const v = c.value ? c.value(row) : (row as Record<string, unknown>)[c.key];
      return `"${String(v ?? "").replace(/"/g, '""')}"`;
    }).join(","));
    const blob = new Blob(["\uFEFF" + head + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName ?? "export"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 no-print">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={searchPlaceholder} className="pl-8" aria-label="Search table" />
        </div>
        {filters.map((f) => (
          <Select key={f.key} value={filterVals[f.key] ?? "ALL"} onValueChange={(v) => { setFilterVals((p) => ({ ...p, [f.key]: v })); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-[170px]" aria-label={f.label}>
              <SelectValue placeholder={f.label} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All {f.label.toLowerCase()}</SelectItem>
              {f.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        <div className="flex items-center gap-2 sm:ml-auto">
          {toolbarExtra}
          {exportName ? (
            <Button variant="outline" size="sm" onClick={exportCsv} aria-label="Export CSV">
              <Download className="h-4 w-4 mr-1.5" /> CSV
            </Button>
          ) : null}
        </div>
      </div>

      {pageRows.length === 0 ? (
        <EmptyState title={emptyTitle} hint={emptyHint} />
      ) : (
        <>
          <div className="hidden lg:block rounded-xl border bg-card overflow-x-auto hms-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((c) => (
                    <TableHead key={c.key} className={cn(c.hideOnMobile && "hidden md:table-cell", c.className)}>
                      {c.sortable !== false && (c.value || (c.key in (rows[0] ?? {}))) ? (
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => {
                            if (sortKey === c.key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                            else { setSortKey(c.key); setSortDir("asc"); }
                          }}
                        >
                          {c.header}
                          <ArrowUpDown className={cn("h-3 w-3", sortKey === c.key ? "text-primary" : "text-muted-foreground/40")} />
                        </button>
                      ) : (
                        c.header
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => (
                  <TableRow
                    key={rowKey(row)}
                    className={onRowClick ? "cursor-pointer" : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {columns.map((c) => (
                      <TableCell key={c.key} className={cn(c.hideOnMobile && "hidden md:table-cell", c.className)}>
                        {c.render ? c.render(row) : String((c.value ? c.value(row) : (row as Record<string, unknown>)[c.key]) ?? "—")}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Phone / tablet: one readable card per row instead of a wide table. */}
          <div className="lg:hidden space-y-2" data-testid="data-table-cards">
            {pageRows.map((row) => (
              <div
                key={rowKey(row)}
                data-testid="data-table-card"
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={(e) => {
                  if (!onRowClick) return;
                  if ((e.target as HTMLElement).closest("button, a, select, [role='checkbox']")) return;
                  onRowClick(row);
                }}
                onKeyDown={(e) => {
                  if (!onRowClick || e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onRowClick(row);
                  }
                }}
                className={cn(
                  "rounded-xl border bg-card p-3 shadow-sm",
                  onRowClick && "cursor-pointer transition-colors hover:bg-accent/35 active:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold leading-snug break-words line-clamp-3 [&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal">{cell(mobileTitle, row)}</div>
                    {mobileMeta ? (
                      <div className="mt-0.5 text-[11px] font-mono text-muted-foreground break-all">{cell(mobileMeta, row)}</div>
                    ) : null}
                  </div>
                </div>
                {mobileStatus.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">{mobileStatus.map((c) => <div key={c.key}>{cell(c, row)}</div>)}</div>
                ) : null}
                {mobileDetails.length > 0 ? (
                  <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t pt-2.5 text-xs">
                    {mobileDetails.map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.header || c.key}</dt>
                        <dd className="mt-0.5 font-medium break-words [&_.truncate]:max-w-none [&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal">{cell(c, row)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {mobileActions ? (
                  <div className="mt-2 flex justify-end border-t pt-1 [&_button]:size-11" onClick={(e) => e.stopPropagation()}>
                    {cell(mobileActions, row)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 no-print">
            <div className="text-sm text-muted-foreground">
              {filtered.length} record{filtered.length === 1 ? "" : "s"}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
                <SelectTrigger className="w-[120px] h-8" aria-label="Rows per page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 20, 50, 100].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-8 w-8" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm px-2 tabular-nums">Page {safePage} / {totalPages}</span>
                <Button variant="outline" size="icon" className="h-8 w-8" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} aria-label="Next page">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
