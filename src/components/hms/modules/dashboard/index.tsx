"use client";

// MOHD.HMS ENTERPRISE — role-based dashboard. Every figure is loaded live from
// the database through the API. Separate loading / empty / error states.

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { StatCard, PageHeader, StatusBadge, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { money, fmtDate, fmtDateTime } from "@/lib/hms/format";
import { humanize } from "@/lib/hms/constants";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, PieChart, Pie, Legend } from "recharts";
import {
  AlertTriangle, Boxes, CalendarClock, ClipboardList, FileWarning,
  HardHat, Receipt, Wrench, TrendingUp, Wallet,
} from "lucide-react";

type Dash = {
  kpis: { openComplaints: number; urgentComplaints: number; activeWOs: number; pendingWOs: number; overduePm: number; lowStock: number; equipmentDown: number; unreadNotifs: number };
  complaintStatusGroups: { status: string; _count: { status: number } }[];
  dailyComplaints: { date: string; count: number }[];
  technicianWorkload: { name: string; open: number; completed: number }[];
  financial: { invoiced: number; collected: number; outstanding: number; expenses: number } | null;
  recentComplaints: { id: string; code: string; title: string; status: string; priority: string; createdAt: string; customer: { companyName: string } }[];
  recentWorkOrders: { id: string; code: string; title: string; status: string; technician: { user: { name: string } } | null; customer: { companyName: string } }[];
  upcomingPm: { id: string; code: string; dueDate: string; status: string; equipment: { name: string; assetTag: string } }[];
  equipmentStatusGroups: { status: string; _count: { status: number } }[];
  mine: { workOrders: number; pmTasks: number } | null;
  role: string;
};

const PIE_COLORS = ["#16a34a", "#0d9488", "#f59e0b", "#84cc16", "#4d7c0f", "#e11d48", "#78716c"];

export function DashboardModule() {
  const { user } = useSession();
  const go = navigateTo;
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Dash>("/api/v1/dashboard");
      setData(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, user?.id]);

  if (error && !data) return <ErrorState message={error} onRetry={load} />;

  const k = data?.kpis;
  const isFinanceView = !!data?.financial;
  const statusData = (data?.complaintStatusGroups ?? []).map((g) => ({ name: humanize(g.status), value: g._count.status }));
  const eqData = (data?.equipmentStatusGroups ?? []).map((g) => ({ name: humanize(g.status), value: g._count.status }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${user?.name?.split(" ")[0] ?? "there"}`}
        subtitle={`${humanize(user?.role)} workspace — live operational overview`}
        actions={<Button variant="outline" size="sm" onClick={load}>Refresh</Button>}
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard title="Open Complaints" value={k?.openComplaints ?? 0} sub={k?.urgentComplaints ? `${k.urgentComplaints} urgent` : "No urgent items"} icon={<AlertTriangle className="h-5 w-5" />} tone={k?.urgentComplaints ? "danger" : "default"} loading={loading} />
        <StatCard title="Active Work Orders" value={k?.activeWOs ?? 0} sub={k?.pendingWOs ? `${k.pendingWOs} awaiting start` : "All underway"} icon={<ClipboardList className="h-5 w-5" />} loading={loading} />
        <StatCard title="PM Due / Overdue" value={k?.overduePm ?? 0} icon={<CalendarClock className="h-5 w-5" />} tone={(k?.overduePm ?? 0) > 0 ? "warning" : "success"} loading={loading} />
        <StatCard title="Equipment Down" value={k?.equipmentDown ?? 0} icon={<Wrench className="h-5 w-5" />} tone={(k?.equipmentDown ?? 0) > 0 ? "warning" : "success"} loading={loading} />
      </div>

      {/* Role extras */}
      {user?.role === "TECHNICIAN" && data?.mine ? (
        <div className="grid grid-cols-2 gap-3">
          <StatCard title="My Work Orders" value={data.mine.workOrders} icon={<ClipboardList className="h-5 w-5" />} loading={loading} />
          <StatCard title="My PM Tasks" value={data.mine.pmTasks} icon={<CalendarClock className="h-5 w-5" />} loading={loading} />
        </div>
      ) : null}
      {isFinanceView && data.financial ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard title="Total Invoiced" value={money(data.financial.invoiced)} icon={<Receipt className="h-5 w-5" />} loading={loading} />
          <StatCard title="Collected" value={money(data.financial.collected)} icon={<Wallet className="h-5 w-5" />} tone="success" loading={loading} />
          <StatCard title="Outstanding" value={money(data.financial.outstanding)} icon={<FileWarning className="h-5 w-5" />} tone={(data.financial.outstanding ?? 0) > 0 ? "warning" : "success"} loading={loading} />
          <StatCard title="Expenses" value={money(data.financial.expenses)} icon={<TrendingUp className="h-5 w-5" />} loading={loading} />
        </div>
      ) : null}
      {!isFinanceView && (k?.lowStock ?? 0) > 0 ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardContent className="p-4 flex items-center gap-3 text-sm">
            <Boxes className="h-5 w-5 text-amber-600 shrink-0" aria-hidden />
            <span><strong>{k?.lowStock}</strong> inventory item{(k?.lowStock ?? 0) === 1 ? "" : "s"} at or below minimum stock.</span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => go("inventory")}>Review inventory</Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-base">Complaints — last 14 days</CardTitle></CardHeader>
          <CardContent className="h-56 sm:h-64">
            {loading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.dailyComplaints ?? []} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0 0)" />
                  <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} fontSize={11} tickLine={false} />
                  <YAxis allowDecimals={false} fontSize={11} tickLine={false} />
                  <Tooltip />
                  <Bar dataKey="count" name="Complaints" fill="oklch(0.53 0.14 154)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Complaints by status</CardTitle></CardHeader>
          <CardContent className="h-56 sm:h-64">
            {loading ? <Skeleton className="h-full w-full" /> : statusData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No complaints yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={statusData} dataKey="value" nameKey="name" innerRadius="52%" outerRadius="80%" paddingAngle={2}>
                    {statusData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent complaints */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Recent complaints</CardTitle>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => go("complaints")}>View all</Button>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-40 w-full" /> : (data?.recentComplaints.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No complaints yet — a calm facility is a happy facility.</p>
            ) : (
              <div className="divide-y">
                {data?.recentComplaints.map((c) => (
                  <button key={c.id} onClick={() => go("complaints", [c.id])} className="w-full text-left py-2.5 flex items-center gap-3 hover:bg-accent/40 rounded-md px-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{c.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{c.code} · {c.customer.companyName} · {fmtDateTime(c.createdAt)}</div>
                    </div>
                    <StatusBadge status={c.priority} />
                    <StatusBadge status={c.status} />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Upcoming PM */}
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Upcoming PM tasks</CardTitle>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => go("pm")}>View all</Button>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-40 w-full" /> : (data?.upcomingPm.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No scheduled maintenance</p>
            ) : (
              <div className="divide-y">
                {data?.upcomingPm.map((t) => (
                  <div key={t.id} className="py-2.5 flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{t.equipment.name}</div>
                      <div className="text-xs text-muted-foreground">{t.code} · due {fmtDate(t.dueDate)}</div>
                    </div>
                    <StatusBadge status={t.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Technician workload */}
        {user?.role !== "CUSTOMER" && (data?.technicianWorkload.length ?? 0) > 0 ? (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><HardHat className="h-4 w-4 text-primary" /> Technician workload</CardTitle></CardHeader>
            <CardContent className="h-52">
              {loading ? <Skeleton className="h-full w-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data?.technicianWorkload ?? []} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0 0)" />
                    <XAxis dataKey="name" fontSize={10} tickLine={false} />
                    <YAxis allowDecimals={false} fontSize={11} tickLine={false} />
                    <Tooltip />
                    <Bar dataKey="open" name="Open" fill="oklch(0.6 0.118 184.704)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="completed" name="Completed" fill="oklch(0.53 0.14 154)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        ) : null}

        {/* Equipment status */}
        <Card className={(data?.technicianWorkload.length ?? 0) > 0 && user?.role !== "CUSTOMER" ? "" : "lg:col-span-1"}>
          <CardHeader className="pb-2"><CardTitle className="text-base">Equipment status</CardTitle></CardHeader>
          <CardContent className="h-52">
            {loading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={eqData} layout="vertical" margin={{ top: 4, right: 12, left: 30, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0 0)" />
                  <XAxis type="number" allowDecimals={false} fontSize={11} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={90} fontSize={11} tickLine={false} />
                  <Tooltip />
                  <Bar dataKey="value" name="Units" fill="oklch(0.53 0.14 154)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent work orders */}
      {user?.role !== "CUSTOMER" || true ? (
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Recent work orders</CardTitle>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => go("work-orders")}>View all</Button>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-32 w-full" /> : (data?.recentWorkOrders.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No work orders yet</p>
            ) : (
              <div className="divide-y">
                {data?.recentWorkOrders.map((w) => (
                  <button key={w.id} onClick={() => go("work-orders", [w.id])} className="w-full text-left py-2.5 flex items-center gap-3 hover:bg-accent/40 rounded-md px-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{w.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{w.code} · {w.customer.companyName} · {w.technician?.user.name ?? "Unassigned"}</div>
                    </div>
                    <StatusBadge status={w.status} />
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
