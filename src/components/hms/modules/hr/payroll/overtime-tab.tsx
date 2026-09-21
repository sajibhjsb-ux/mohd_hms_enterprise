"use client";

// HR ▸ Overtime tab (spec §15) — existing HR approval architecture
// (PENDING → APPROVED/REJECTED via hr.manage). Payable amounts are computed
// server-side at approval; only APPROVED overtime enters payroll.

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate, money } from "@/lib/hms/format";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";
import { StatusBadge } from "@/components/hms/shared/ui-bits";

type OvertimeRow = {
  id: string; employeeNo: string; employeeName: string; date: string;
  hours: number; multiplier: number; reason: string; status: string;
  amountCents: number; rateBasisCents: number; approvedByName: string;
};

export function OvertimeTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const [rows, setRows] = useState<OvertimeRow[] | null>(null);
  const [busyId, setBusyId] = useState("");
  const canManage = hasPerm(user, PERMISSIONS.hr_manage);

  const load = useCallback(async () => {
    const res = await api.get<OvertimeRow[]>(`/api/v1/hr/payroll/overtime${qs({ pageSize: 200 })}`);
    setRows(res.data);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.payroll, () => void load());

  const act = async (id: string, action: "approve" | "reject") => {
    setBusyId(id);
    try {
      await api.patch(`/api/v1/hr/payroll/overtime/${id}`, { action });
      toast({ title: action === "approve" ? "Overtime approved" : "Overtime rejected", description: action === "approve" ? "The amount is computed and will enter payroll (§15)." : undefined });
      await load();
    } catch (e) {
      toast({ title: "Failed", description: e instanceof Error ? e.message : "Error", variant: "destructive" });
    } finally {
      setBusyId("");
    }
  };

  const cols: Column<OvertimeRow>[] = [
    {
      key: "employee", header: "Employee", sortable: true, value: (r) => r.employeeName,
      render: (r) => <div><div className="font-medium">{r.employeeName}</div><div className="text-xs text-muted-foreground">{r.employeeNo}</div></div>,
    },
    { key: "date", header: "Date", sortable: true, value: (r) => r.date, render: (r) => fmtDate(r.date) },
    { key: "hours", header: "Hours", sortable: true, value: (r) => r.hours, render: (r) => `${r.hours.toFixed(2)} h × ${r.multiplier}` },
    { key: "reason", header: "Reason", value: (r) => r.reason, hideOnMobile: true },
    {
      key: "amount", header: "Amount", sortable: true, value: (r) => r.amountCents,
      render: (r) => (r.status === "APPROVED" ? money(r.amountCents) : <span className="text-muted-foreground">—</span>),
    },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "approver", header: "Approved By", value: (r) => r.approvedByName, hideOnMobile: true },
    {
      key: "actions", header: "",
      render: (r) =>
        canManage && r.status === "PENDING" ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2" disabled={busyId === r.id} onClick={() => act(r.id, "approve")} aria-label={`Approve overtime for ${r.employeeName}`}>
              <Check className="h-3.5 w-3.5 text-emerald-600" />
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2" disabled={busyId === r.id} onClick={() => act(r.id, "reject")} aria-label={`Reject overtime for ${r.employeeName}`}>
              <X className="h-3.5 w-3.5 text-red-600" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3" data-testid="overtime-tab">
      <p className="text-xs text-muted-foreground">
        Approved overtime feeds the payroll engine automatically (§15). Employees file via their profile; HR approves — amounts are derived from each employee&apos;s basic salary and snapshotted.
      </p>
      {rows ? (
        <DataTable<OvertimeRow>
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          searchPlaceholder="Search employee…"
          exportName="overtime"
          filters={[
            { key: "status", label: "Status", options: ["PENDING", "APPROVED", "REJECTED"].map((s) => ({ value: s, label: s })), match: (r, v) => r.status === v },
          ]}
        />
      ) : null}
    </div>
  );
}
