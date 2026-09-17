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
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyHint?: string;
  toolbarExtra?: ReactNode;
  exportName?: string;
  pageSizeDefault?: number;
};

export function DataTable<T>({
  columns, rows, rowKey, searchPlaceholder = "Search…", filters = [], onRowClick,
  emptyTitle = "No records found", emptyHint, toolbarExtra, exportName, pageSizeDefault = 10,
}: Props<T>) {
  const [search, setSearch] = useState("");
  const [filterVals, setFilterVals] = useState<Record<string, string>>({});
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
      <div className="flex flex-col lg:flex-row lg:items-center gap-2 no-print">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={searchPlaceholder} className="pl-8" aria-label="Search table" />
        </div>
        {filters.map((f) => (
          <Select key={f.key} value={filterVals[f.key] ?? "ALL"} onValueChange={(v) => { setFilterVals((p) => ({ ...p, [f.key]: v })); setPage(1); }}>
            <SelectTrigger className="w-full lg:w-[170px]" aria-label={f.label}>
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
        <div className="flex items-center gap-2 lg:ml-auto">
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
          <div className="rounded-xl border bg-card overflow-x-auto hms-scroll">
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
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 no-print">
            <div className="text-sm text-muted-foreground">
              {filtered.length} record{filtered.length === 1 ? "" : "s"}
            </div>
            <div className="flex items-center gap-3">
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
                <SelectTrigger className="w-[110px] h-8" aria-label="Rows per page">
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
