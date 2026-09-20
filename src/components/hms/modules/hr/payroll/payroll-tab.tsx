"use client";

// HR ▸ Payroll tab (spec §31 dashboard + §32 run list). Real PostgreSQL data
// only. Actions are RBAC/status-gated on the server; the UI mirrors that.

import { useCallback, useEffect, useState } from "react";
import {
  Banknote, Calculator, CalendarRange, ChevronRight, Plus, ReceiptText, ShieldAlert, Users,
} from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate, money } from "@/lib/hms/format";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingState, StatCard, StatusBadge } from "@/components/hms/shared/ui-bits";

type Run = {
  id: string;
  code: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  employeeCount: number;
  grossCents: number;
  deductionsCents: number;
  employerCostCents: number;
  netCents: number;
  exceptionCount: number;
  payDate: string | null;
  creatorName: string;
  approverName: string;
  createdAt: string;
};

type Dashboard = {
  totalEmployees: number;
  payrollEmployees: number;
  current: {
    id: string; code: string; name: string; status: string;
    employeeCount: number; grossCents: number; deductionsCents: number;
    employerCostCents: number; netCents: number; exceptionCount: number;
  } | null;
  statusCounts: Record<string, number>;
  runs: Run[];
  pendingAdjustments: number;
  pendingOvertime: number;
  statutoryCount: number;
  componentCount: number;
};

export function PayrollTab() {
  const { user } = useSession();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState("");

  const canManage = hasPerm(user, PERMISSIONS.payroll_manage);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([
        api.get<Dashboard>("/api/v1/hr/payroll/dashboard"),
        api.get<Run[]>(`/api/v1/hr/payroll/runs${qs({ pageSize: 200 })}`),
      ]);
      setDash(d.data);
      setRuns(r.data);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load payroll data.");
    }
  }, []);

  useEffect(() => {
    // rAF off-path (house pattern for the React 19 set-state-in-effect rule):
    // the fetch lands outside the effect's synchronous render pass.
    const raf = requestAnimationFrame(() => { void load(); });
    return () => cancelAnimationFrame(raf);
  }, [load]);
  useRealtimeEvent(MODULE_EVENTS.payroll, () => void load());

  if (error) {
    return <EmptyState title="Payroll unavailable" hint={error} />;
  }
  if (!dash || !runs) return <LoadingState label="Loading payroll…" rows={4} />;

  const cur = dash.current;

  return (
    <div className="space-y-6" data-testid="payroll-tab">
      {/* §31 — current period KPIs (real aggregates) */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={cur ? cur.name : "No payroll period yet"}
          value={cur ? money(cur.grossCents) : "—"}
          sub={cur ? `${cur.employeeCount} employees · ${cur.status}` : "Create the first run"}
          icon={<CalendarRange className="h-5 w-5" />}
        />
        <StatCard title="Deductions" value={cur ? money(cur.deductionsCents) : "—"} sub={cur ? "Employee deductions (current period)" : "—"} icon={<ReceiptText className="h-5 w-5" />} />
        <StatCard title="Net Payroll" value={cur ? money(cur.netCents) : "—"} sub={cur ? `Employer cost ${money(cur.employerCostCents)}` : "—"} icon={<Banknote className="h-5 w-5" />} />
        <StatCard
          title="Payroll Exceptions"
          value={cur ? cur.exceptionCount : 0}
          sub={cur ? "Flagged for review (§44)" : "—"}
          icon={<ShieldAlert className="h-5 w-5" />}
          tone={cur && cur.exceptionCount > 0 ? "warning" : "default"}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Payroll Employees" value={dash.payrollEmployees} sub={`${dash.totalEmployees} total on register`} icon={<Users className="h-5 w-5" />} />
        <StatCard title="Pending Adjustments" value={dash.pendingAdjustments} sub="Awaiting approval (§24)" icon={<Calculator className="h-5 w-5" />} />
        <StatCard title="Pending Overtime" value={dash.pendingOvertime} sub="Awaiting approval (§15)" icon={<Calculator className="h-5 w-5" />} />
        <StatCard title="Setup" value={`${dash.componentCount} components`} sub={`${dash.statutoryCount} statutory rules active`} icon={<ReceiptText className="h-5 w-5" />} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Payroll Runs</h3>
          <p className="text-xs text-muted-foreground">
            One run per period — duplicates are rejected. Draft → Review → Approved → Finalized → Paid → Locked.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => navigateTo("hr", ["payroll", "setup"])}>
            Setup &amp; Salaries
          </Button>
          {canManage ? (
            <Button size="sm" onClick={() => navigateTo("hr", ["payroll", "new"])} data-testid="new-run-btn">
              <Plus className="h-4 w-4 mr-1.5" /> New Payroll Run
            </Button>
          ) : null}
        </div>
      </div>

      {runs.length === 0 ? (
        <EmptyState
          title="No payroll runs yet"
          hint={canManage ? "Create the first payroll run to calculate salaries for a period." : "Payroll runs will appear here once HR prepares them."}
        />
      ) : (
        <DataTable<Run>
          columns={runColumns}
          rows={runs}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigateTo("hr", ["payroll", r.id])}
          searchPlaceholder="Search code, name, period…"
          exportName="payroll-runs"
          filters={[
            {
              key: "status",
              label: "Status",
              options: ["DRAFT", "CALCULATING", "REVIEW", "APPROVED", "FINALIZED", "PAID", "LOCKED", "FAILED", "CANCELLED"].map((s) => ({ value: s, label: s })),
              match: (r, v) => r.status === v,
            },
          ]}
        />
      )}
    </div>
  );
}

const runColumns: Column<Run>[] = [
  {
    key: "name", header: "Payroll Period", sortable: true,
    value: (r) => r.name,
    render: (r) => (
      <div>
        <div className="font-medium">{r.name}</div>
        <div className="text-xs text-muted-foreground">{r.code} · {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}</div>
      </div>
    ),
  },
  { key: "employeeCount", header: "Employees", sortable: true, value: (r) => r.employeeCount, hideOnMobile: true },
  { key: "gross", header: "Gross", sortable: true, value: (r) => r.grossCents, render: (r) => money(r.grossCents) },
  { key: "deductions", header: "Deductions", sortable: true, value: (r) => r.deductionsCents, render: (r) => money(r.deductionsCents), hideOnMobile: true },
  { key: "net", header: "Net", sortable: true, value: (r) => r.netCents, render: (r) => <span className="font-medium">{money(r.netCents)}</span> },
  { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
  { key: "creator", header: "Created By", value: (r) => r.creatorName, hideOnMobile: true },
  { key: "approver", header: "Approved By", value: (r) => r.approverName, hideOnMobile: true },
  {
    key: "actions", header: "",
    render: () => <span className="flex items-center text-xs text-muted-foreground">Open <ChevronRight className="h-3.5 w-3.5" /></span>,
  },
];
