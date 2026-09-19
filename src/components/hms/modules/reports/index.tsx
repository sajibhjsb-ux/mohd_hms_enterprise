"use client";

// Reports module — selectable report types, date range, summary KPIs,
// dynamic data table, server-side CSV export and print view.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BarChart3, CalendarClock, Download, HardHat, Printer, QrCode, Wallet, Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate, money } from "@/lib/hms/format";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Row = Record<string, string | number | null | undefined>;
type SummaryValue = number | Record<string, number>;
type ReportData = {
  type: string;
  from: string;
  to: string;
  summary: Record<string, SummaryValue>;
  rows: Row[];
  expenses?: Row[];
};

const REPORTS: { type: string; label: string; description: string; icon: LucideIcon }[] = [
  { type: "complaints", label: "Complaints", description: "Volume, status and priority mix", icon: AlertTriangle },
  { type: "work_orders", label: "Work Orders", description: "Jobs, hours and total value", icon: Wrench },
  { type: "equipment", label: "Equipment", description: "Fleet health and warranty", icon: QrCode },
  { type: "pm_compliance", label: "PM Compliance", description: "Preventive maintenance adherence", icon: CalendarClock },
  { type: "finance", label: "Finance", description: "Invoiced, collected, outstanding", icon: Wallet },
  { type: "technicians", label: "Technicians", description: "Workload and completions", icon: HardHat },
];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const DEFAULT_FROM = isoDay(new Date(Date.now() - 29 * 86400000));
const DEFAULT_TO = isoDay(new Date());

function formatSummaryValue(key: string, value: number): string {
  if (key.toLowerCase().endsWith("cents")) return money(value);
  if (key === "completionRate") return `${value}%`;
  return String(value);
}

function renderCell(key: string, value: Row[string]) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  if (/cents$/i.test(key)) return <span className="tabular-nums">{money(Number(value))}</span>;
  if (/^(date|duedate|warrantyexpiry|completedat|lastservicedate|nextservicedue)$/i.test(key)) return fmtDate(String(value));
  if (key === "status" || key === "priority") return <StatusBadge status={String(value)} />;
  return <span>{String(value)}</span>;
}

export function ReportsModule() {
  const { user } = useSession();
  const { toast } = useToast();

  const [type, setType] = useState<string>("complaints");
  const [fromInput, setFromInput] = useState(DEFAULT_FROM);
  const [toInput, setToInput] = useState(DEFAULT_TO);
  const [range, setRange] = useState({ from: DEFAULT_FROM, to: DEFAULT_TO });

  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canExport = hasPerm(user, PERMISSIONS.reports_export);

  const load = useCallback(
    async (reportType: string, from: string, to: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<ReportData>(`/api/v1/reports${qs({ type: reportType, from, to })}`);
        setData(res.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to load report.");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    load(type, range.from, range.to);
  }, [type, range, load]);

  const selectReport = (next: string) => {
    if (next === type) return;
    setType(next);
  };

  const applyRange = () => {
    if (fromInput && toInput && fromInput > toInput) {
      toast({ title: "Invalid date range", description: "From must be on or before To.", variant: "destructive" });
      return;
    }
    setRange({ from: fromInput || DEFAULT_FROM, to: toInput || DEFAULT_TO });
  };

  const activeReport = REPORTS.find((r) => r.type === type);

  const columns: Column<Row>[] = useMemo(() => {
    const first = data?.rows?.[0];
    if (!first) return [];
    return Object.keys(first).map((key, idx) => ({
      key,
      header: humanize(key),
      value: (row: Row) => row[key] ?? undefined,
      render: (row: Row) => renderCell(key, row[key]),
      className: /cents$/i.test(key) ? "text-right tabular-nums" : undefined,
      hideOnMobile: idx >= 4,
    }));
  }, [data]);

  const exportCsv = () => {
    window.location.href = `/api/v1/reports/export${qs({ type, from: range.from, to: range.to })}`;
  };

  const scalarSummary = Object.entries(data?.summary ?? {}).filter(
    ([, v]) => typeof v === "number"
  ) as [string, number][];
  const groupSummary = Object.entries(data?.summary ?? {}).filter(
    ([, v]) => typeof v === "object" && v !== null
  ) as [string, Record<string, number>][];

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Operational and financial reporting across the enterprise"
        actions={
          <>
            {canExport ? (
              <Button variant="outline" size="sm" onClick={exportCsv} aria-label="Export CSV">
                <Download className="h-4 w-4 mr-1.5" /> Export CSV
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => window.print()} aria-label="Print report">
              <Printer className="h-4 w-4 mr-1.5" /> Print
            </Button>
          </>
        }
      />

      {/* Print-only report header (screen UI uses PageHeader) */}
      <div className="hidden print:block mb-4 border-b pb-3">
        <div className="text-lg font-bold tracking-tight">MOHD.HMS ENTERPRISE</div>
        <div className="text-sm">
          {activeReport?.label ?? "Report"} Report · {fmtDate(range.from)} — {fmtDate(range.to)}
        </div>
        <div className="text-xs text-muted-foreground mt-1">Currency: BND (Brunei Darussalam)</div>
      </div>

      {/* Report type selector */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2 sm:gap-3 mb-4 no-print">
        {REPORTS.map((r) => {
          const Icon = r.icon;
          const selected = r.type === type;
          return (
            <button
              key={r.type}
              type="button"
              onClick={() => selectReport(r.type)}
              aria-pressed={selected}
              className={`text-left rounded-xl border p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                selected ? "border-primary bg-primary/10" : "bg-card hover:bg-muted/50"
              }`}
            >
              <Icon className={`h-5 w-5 mb-2 ${selected ? "text-primary" : "text-muted-foreground"}`} aria-hidden />
              <div className="text-sm font-medium leading-tight">{r.label}</div>
              <div className="text-xs text-muted-foreground mt-0.5 hidden sm:block">{r.description}</div>
            </button>
          );
        })}
      </div>

      {/* Date range */}
      <Card className="mb-5 no-print">
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="report-from">From</Label>
            <Input id="report-from" type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} className="w-full sm:w-[170px]" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="report-to">To</Label>
            <Input id="report-to" type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} className="w-full sm:w-[170px]" />
          </div>
          <Button size="sm" onClick={applyRange} className="sm:mb-0.5">
            <BarChart3 className="h-4 w-4 mr-1.5" /> Apply
          </Button>
          <div className="text-xs text-muted-foreground sm:ml-auto sm:mb-1">
            Showing {fmtDate(range.from)} — {fmtDate(range.to)}
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <LoadingState label="Building report…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(type, range.from, range.to)} />
      ) : !data || data.rows.length === 0 ? (
        <EmptyState
          title="No data for this report"
          hint={`No ${activeReport?.label.toLowerCase() ?? ""} records were found in the selected period. Try widening the date range.`}
        />
      ) : (
        <div className="space-y-5">
          {/* Summary KPIs */}
          {scalarSummary.length > 0 ? (
            <div className={`grid gap-3 ${scalarSummary.length >= 4 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-2 sm:grid-cols-3"}`}>
              {scalarSummary.map(([key, value]) => (
                <StatCard key={key} title={humanize(key)} value={formatSummaryValue(key, value)} />
              ))}
            </div>
          ) : null}

          {/* Distribution summaries (byStatus / byPriority) */}
          {groupSummary.map(([key, group]) => (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground mr-1">{humanize(key)}:</span>
              {Object.keys(group).length === 0 ? (
                <span className="text-sm text-muted-foreground">—</span>
              ) : (
                Object.entries(group).map(([status, count]) => (
                  <Badge key={status} variant="outline" className="gap-1.5">
                    {key === "byStatus" || key === "byPriority" ? <StatusBadge status={status} /> : humanize(status)}
                    <span className="tabular-nums font-semibold">{count}</span>
                  </Badge>
                ))
              )}
            </div>
          ))}

          <DataTable
            columns={columns}
            rows={data.rows}
            rowKey={(row) => String(row.code ?? row.assetTag ?? row.name ?? "row")}
            searchPlaceholder={`Search ${activeReport?.label.toLowerCase() ?? "report"}…`}
            emptyTitle="No rows in this period"
          />

          {/* Expenses breakdown for the finance report */}
          {data.type === "finance" && data.expenses && data.expenses.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold mb-2">Expenses in period</h3>
              <DataTable
                columns={Object.keys(data.expenses[0]).map((key) => ({
                  key,
                  header: humanize(key),
                  value: (row: Row) => row[key] ?? undefined,
                  render: (row: Row) => renderCell(key, row[key]),
                  className: /cents$/i.test(key) ? "text-right tabular-nums" : undefined,
                }))}
                rows={data.expenses}
                rowKey={(row) => String(row.code ?? "exp")}
                searchPlaceholder="Search expenses…"
                emptyTitle="No expenses in this period"
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
