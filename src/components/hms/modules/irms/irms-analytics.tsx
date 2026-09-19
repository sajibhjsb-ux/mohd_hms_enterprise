"use client";

// MOHD.HMS ENTERPRISE — IRMS analytics (staff-only, recharts).
//
// GET /api/v1/irms/analytics?from&to (contract §11; default last 12 months).
// Range presets: This year / Last 12 months. Charts: reports by status, by
// type, top projects (horizontal), by inspector, monthly created vs approved
// (line), finding severity (pie). StatCards show the average approval cycle
// hours and totals. Staff-only: the IRMS module registry gate already applies
// (irms.read), and the API enforces it server-side. Responsive containers.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { useRealtimeEventDebounced } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatCard } from "@/components/hms/shared/ui-bits";
import { IrmsSectionNav } from "./irms-dashboard";
import { humanize } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { TrendingUp } from "lucide-react";

type Analytics = {
  byStatus: { status: string; count: number }[];
  byType: { type: string; count: number }[];
  byProject: { project: string; count: number }[];
  byInspector: { inspector: string; count: number }[];
  monthly: { month: string; created: number; approved: number }[];
  defectSeverity: { severity: string; count: number }[];
  avgApprovalHours: number | null;
};

const GREEN_SHADES = ["#047857", "#059669", "#10b981", "#34d399", "#6ee7b7", "#a7f3d0", "#d1fae5", "#065f46"];
const SEVERITY_COLORS: Record<string, string> = {
  LOW: "#a8a29e",
  MEDIUM: "#f59e0b",
  HIGH: "#ea580c",
  CRITICAL: "#dc2626",
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Preset = "thisYear" | "last12";

function rangeFor(preset: Preset): { from: string; to: string } {
  const now = new Date();
  if (preset === "thisYear") {
    return { from: `${now.getFullYear()}-01-01`, to: ymd(now) };
  }
  const past = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 364);
  return { from: ymd(past), to: ymd(now) };
}

const axisProps = { fontSize: 11, tickLine: false, axisLine: false } as const;

export function IrmsAnalyticsPage() {
  const [preset, setPreset] = useState<Preset>("last12");
  const { from, to } = useMemo(() => rangeFor(preset), [preset]);

  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Analytics>(`/api/v1/irms/analytics${qs({ from, to })}`);
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load IRMS analytics.");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  useRealtimeEventDebounced(MODULE_EVENTS.irms, () => { void load(); });

  const statusData = (data?.byStatus ?? []).map((d) => ({ name: humanize(d.status), count: d.count }));
  const typeData = (data?.byType ?? []).map((d) => ({ name: humanize(d.type), count: d.count }));
  const projectData = (data?.byProject ?? []).map((d) => ({ name: d.project, count: d.count }));
  const inspectorData = (data?.byInspector ?? []).map((d) => ({ name: d.inspector, count: d.count }));
  const monthlyData = (data?.monthly ?? []).map((d) => ({
    name: d.month,
    Created: d.created,
    Approved: d.approved,
  }));
  const severityData = (data?.defectSeverity ?? []).map((d) => ({ name: humanize(d.severity), value: d.count, key: d.severity }));

  const totalReports = statusData.reduce((s, d) => s + d.count, 0);
  const totalCreated = monthlyData.reduce((s, d) => s + d.Created, 0);
  const totalApproved = monthlyData.reduce((s, d) => s + d.Approved, 0);
  const isEmpty = !loading && !error && totalReports === 0 && totalCreated === 0 && severityData.length === 0;

  return (
    <div>
      <IrmsSectionNav active="analytics" />
      <PageHeader
        title="IRMS Analytics"
        subtitle="Inspection throughput, defects and approval performance"
        actions={
          <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-1">
            <Button
              variant={preset === "thisYear" ? "default" : "ghost"} size="sm"
              onClick={() => setPreset("thisYear")}
              aria-pressed={preset === "thisYear"}
            >
              This year
            </Button>
            <Button
              variant={preset === "last12" ? "default" : "ghost"} size="sm"
              onClick={() => setPreset("last12")}
              aria-pressed={preset === "last12"}
            >
              Last 12 months
            </Button>
          </div>
        }
      />

      {loading ? (
        <LoadingState label="Loading analytics…" rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : isEmpty ? (
        <EmptyState
          title="No inspection data for this range"
          hint="Create and submit inspection reports — charts build up as the workflow runs."
          action={<Button size="sm" variant="outline" onClick={() => setPreset("last12")}>Switch to Last 12 months</Button>}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              title="Avg approval cycle"
              value={
                data?.avgApprovalHours != null
                  ? data.avgApprovalHours >= 1
                    ? `${data.avgApprovalHours.toFixed(1)} h`
                    : `${Math.max(1, Math.round(data.avgApprovalHours * 60))} min`
                  : "—"
              }
              sub="submit → approve"
              icon={<TrendingUp className="h-5 w-5" />}
            />
            <StatCard title="Reports in range" value={totalReports} sub="all statuses" />
            <StatCard title="Created" value={totalCreated} sub="monthly sum" tone="default" />
            <StatCard title="Approved" value={totalApproved} sub="monthly sum" tone="success" />
          </div>

          {/* grid-cols-1 caps the mobile track at container width (see irms-dashboard) */}
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="Reports by status">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={statusData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e5e4" />
                  <XAxis dataKey="name" {...axisProps} interval={0} angle={-18} textAnchor="end" height={54} />
                  <YAxis allowDecimals={false} {...axisProps} />
                  <Tooltip />
                  <Bar dataKey="count" name="Reports" radius={[4, 4, 0, 0]}>
                    {statusData.map((_, i) => <Cell key={i} fill={GREEN_SHADES[i % GREEN_SHADES.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Reports by type">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={typeData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e5e4" />
                  <XAxis dataKey="name" {...axisProps} />
                  <YAxis allowDecimals={false} {...axisProps} />
                  <Tooltip />
                  <Bar dataKey="count" name="Reports" fill="#059669" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Top projects">
              {projectData.length === 0 ? (
                <ChartEmpty />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={projectData} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e7e5e4" />
                    <XAxis type="number" allowDecimals={false} {...axisProps} />
                    <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Bar dataKey="count" name="Reports" fill="#10b981" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            <ChartCard title="Reports by inspector">
              {inspectorData.length === 0 ? (
                <ChartEmpty />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={inspectorData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e5e4" />
                    <XAxis dataKey="name" {...axisProps} interval={0} angle={-18} textAnchor="end" height={54} />
                    <YAxis allowDecimals={false} {...axisProps} />
                    <Tooltip />
                    <Bar dataKey="count" name="Reports" fill="#047857" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            <ChartCard title="Created vs approved (monthly)">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={monthlyData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e5e4" />
                  <XAxis dataKey="name" {...axisProps} />
                  <YAxis allowDecimals={false} {...axisProps} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="Created" stroke="#059669" strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="Approved" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Finding severity">
              {severityData.length === 0 ? (
                <ChartEmpty />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Tooltip />
                    <Legend />
                    <Pie data={severityData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                      {severityData.map((d) => <Cell key={d.key} fill={SEVERITY_COLORS[d.key] ?? "#a8a29e"} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      {/* overflow-hidden: recharts tooltip wrappers are absolutely positioned
          (and visibility:hidden before hover) — unclipped they extend the
          document width on phones, which read as a zoomed-out page. Clipping
          at the card keeps every chart inside the viewport. */}
      <CardContent className="overflow-hidden">{children}</CardContent>
    </Card>
  );
}

function ChartEmpty() {
  return <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">No data in this range.</div>;
}
