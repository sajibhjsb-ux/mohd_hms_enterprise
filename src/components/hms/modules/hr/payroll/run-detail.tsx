"use client";

// HR ▸ Payroll ▸ Run detail (spec §9/§27/§33/§34/§44/§45/§48/§50).
// Workflow hub: calculate → review → approve → finalize → payslips → paid →
// lock, with the full traceable employee breakdown and review exceptions.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BadgeCheck, Ban, Calculator, Download, FileText, Loader2,
  Lock, PlayCircle, ShieldCheck, Wallet,
} from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { fmtDate, money } from "@/lib/hms/format";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, LoadingState, StatCard, StatusBadge } from "@/components/hms/shared/ui-bits";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { PayrollLine } from "@/lib/hms/payroll/config";

type RunDetail = {
  id: string; code: string; name: string; periodKey: string;
  periodStart: string; periodEnd: string; status: string;
  employeeCount: number; grossCents: number; deductionsCents: number;
  employerCostCents: number; netCents: number; exceptionCount: number;
  payDate: string | null; paymentRef: string; errorNote: string;
  creatorName: string; approverName: string; payerName: string;
  approvedAt: string | null; finalizedAt: string | null; paidAt: string | null;
  items: ItemRow[];
  adjustments: AdjustmentRow[];
  review: {
    previousRun: { id: string; code: string } | null;
    removedEmployees: { employeeNo: string; employeeName: string; prevNetCents: number }[];
    flaggedItems: { id: string; employeeNo: string; employeeName: string; netCents: number; varianceBps: number | null; flags: string[] }[];
    exceptionCount: number;
  };
};

type ItemRow = {
  id: string; employeeId: string; employeeNo: string; employeeName: string;
  departmentName: string; positionName: string; status: string;
  workingDays: number; workedDays: number; paidLeaveDays: number; unpaidLeaveDays: number; absentDays: number;
  otMinutes: number; basicCents: number; allowancesCents: number; overtimeCents: number;
  adjustmentsEarningsCents: number; grossCents: number; statutoryCents: number;
  otherDeductionsCents: number; adjustmentsDeductionsCents: number; deductionsCents: number;
  netCents: number; employerCostCents: number; varianceBps: number | null;
  flags: string[]; lines: PayrollLine[];
  payslipObjectKey: string | null; payslipGeneratedAt: string | null;
};

type AdjustmentRow = {
  id: string; employeeNo?: string; employeeName?: string; direction: string; category: string;
  amountCents: number; reason: string; status: string; createdAt: string;
};

const FLAG_LABELS: Record<string, string> = {
  NEW_EMPLOYEE: "New in payroll",
  NET_CHANGE_GT_30: "Net changed >30%",
  DEDUCTION_HEAVY: "Deductions >60% of gross",
  LARGE_OT: "Overtime >30% of gross",
  NEGATIVE_NET: "Negative net pay",
  MISSING_SALARY: "No salary data",
};

export function PayrollRunDetailPage({ runId }: { runId: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [selected, setSelected] = useState<ItemRow | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ action: string; label: string } | null>(null);
  const [paymentRef, setPaymentRef] = useState("");

  const canManage = hasPerm(user, PERMISSIONS.payroll_manage);
  const canApprove = hasPerm(user, PERMISSIONS.payroll_approve);

  const load = useCallback(async () => {
    try {
      const res = await api.get<RunDetail>(`/api/v1/hr/payroll/runs/${runId}`);
      setRun(res.data);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the payroll run.");
    }
  }, [runId]);

  useEffect(() => { void load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.payroll, () => void load());

  const doTransition = useCallback(async (action: string, extra?: Record<string, unknown>) => {
    setBusy(action);
    try {
      await api.post(`/api/v1/hr/payroll/runs/${runId}/transition`, { action, ...extra });
      toast({ title: `Payroll ${action.replace("_", " ")} — done` });
      setConfirmAction(null);
      setPaymentRef("");
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Unexpected error", variant: "destructive" });
    } finally {
      setBusy("");
    }
  }, [runId, load, toast]);

  const doCalculate = useCallback(async () => {
    setBusy("calculate");
    try {
      const res = await api.post<{ employeeCount: number; netCents: number; exceptionCount: number }>(`/api/v1/hr/payroll/runs/${runId}/calculate`, {});
      toast({ title: "Payroll calculated", description: `${res.data.employeeCount} employees · net ${money(res.data.netCents)} · ${res.data.exceptionCount} exception(s)` });
      await load();
    } catch (e) {
      toast({ title: "Payroll calculation failed", description: e instanceof Error ? e.message : "Unexpected error", variant: "destructive" });
    } finally {
      setBusy("");
    }
  }, [runId, load, toast]);

  const doGeneratePayslips = useCallback(async () => {
    setBusy("payslips");
    try {
      const res = await api.post<{ generated: number; failed: number }>(`/api/v1/hr/payroll/runs/${runId}/payslips`, {});
      toast({ title: "Payslips generated", description: `${res.data.generated} stored to document storage · ${res.data.failed} failed` });
      await load();
    } catch (e) {
      toast({ title: "Payslip generation failed", description: e instanceof Error ? e.message : "Unexpected error", variant: "destructive" });
    } finally {
      setBusy("");
    }
  }, [runId, load, toast]);

  const status = run?.status ?? "";
  const statutoryTotal = useMemo(() => (run?.items ?? []).reduce((s, i) => s + i.statutoryCents, 0), [run]);
  const otherTotal = useMemo(() => (run?.items ?? []).reduce((s, i) => s + i.otherDeductionsCents + i.adjustmentsDeductionsCents, 0), [run]);
  const actions = useMemo(() => {
    const list: { key: string; label: string; icon: React.ReactNode; onClick: () => void; variant?: "default" | "outline" | "destructive" | "secondary"; testid?: string }[] = [];
    if (!run) return list;
    if (canManage && ["DRAFT", "FAILED", "REVIEW"].includes(run.status)) {
      list.push({ key: "calculate", label: run.employeeCount > 0 ? "Recalculate" : "Calculate Payroll", icon: busy === "calculate" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Calculator className="h-4 w-4 mr-2" />, onClick: doCalculate, testid: "calc-btn" });
    }
    if (canManage && run.status === "REVIEW") {
      list.push({ key: "submit", label: "Submit for Approval", icon: <PlayCircle className="h-4 w-4 mr-2" />, onClick: () => doTransition("submit"), variant: "outline" });
    }
    if (canApprove && run.status === "REVIEW") {
      list.push({ key: "approve", label: "Approve", icon: <BadgeCheck className="h-4 w-4 mr-2" />, onClick: () => setConfirmAction({ action: "approve", label: "Approve this payroll run?" }), testid: "approve-btn" });
    }
    if (canApprove && run.status === "APPROVED") {
      list.push({ key: "finalize", label: "Finalize", icon: <ShieldCheck className="h-4 w-4 mr-2" />, onClick: () => setConfirmAction({ action: "finalize", label: "Finalize this payroll run? Values become immutable." }), testid: "finalize-btn" });
    }
    if (canManage && ["FINALIZED", "PAID"].includes(run.status)) {
      list.push({ key: "payslips", label: run.items.some((i) => i.payslipObjectKey) ? "Regenerate Payslips" : "Generate Payslips", icon: busy === "payslips" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileText className="h-4 w-4 mr-2" />, onClick: doGeneratePayslips, testid: "payslips-btn" });
    }
    if (canApprove && run.status === "FINALIZED") {
      list.push({ key: "mark_paid", label: "Mark Paid", icon: <Wallet className="h-4 w-4 mr-2" />, onClick: () => setConfirmAction({ action: "mark_paid", label: "Confirm actual payment? This posts the net payroll to the finance ledger." }), testid: "paid-btn" });
    }
    if (user?.role === "SUPER_ADMIN" && run.status === "PAID") {
      list.push({ key: "lock", label: "Lock Period", icon: <Lock className="h-4 w-4 mr-2" />, onClick: () => setConfirmAction({ action: "lock", label: "Lock this payroll period? A locked period can never be modified." }) });
    }
    if (canManage && ["DRAFT", "FAILED"].includes(run.status)) {
      list.push({ key: "cancel", label: "Cancel Run", icon: <Ban className="h-4 w-4 mr-2" />, onClick: () => setConfirmAction({ action: "cancel", label: "Cancel this draft run?" }), variant: "outline" });
    }
    return list;
  }, [run, canManage, canApprove, user?.role, busy, doCalculate, doTransition, doGeneratePayslips]);

  if (error) {
    return (
      <PageShell backLabel="Back to HR" backHref="/hr" title="Payroll Run">
        <EmptyState title="Run unavailable" hint={error} />
      </PageShell>
    );
  }
  if (!run) return <LoadingState label="Loading payroll run…" rows={6} />;

  const editable = ["DRAFT", "FAILED", "REVIEW"].includes(run.status);

  return (
    <PageShell
      backLabel="Back to HR" backHref="/hr"
      crumbs={[{ label: "HR", href: "/hr" }, { label: "Payroll", href: "/hr?tab=payroll" }, { label: run.code }]}
      title={`${run.name}`}
      description={`${run.code} · ${fmtDate(run.periodStart)} – ${fmtDate(run.periodEnd)} · created by ${run.creatorName || "—"}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((a) => (
            <Button key={a.key} size="sm" variant={a.variant ?? "default"} onClick={a.onClick} disabled={!!busy} data-testid={a.testid}>
              {a.icon}{a.label}
            </Button>
          ))}
          {run.items.length > 0 ? (
            <a href={`/api/v1/hr/payroll/runs/${run.id}/export`} download>
              <Button size="sm" variant="outline"><Download className="h-4 w-4 mr-2" />Export CSV</Button>
            </a>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4" data-testid="run-detail">
        {run.errorNote && run.status === "FAILED" ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            <span className="font-semibold">PAYROLL CALCULATION FAILED — </span>{run.errorNote} You can retry after the root cause is addressed (§63).
          </div>
        ) : null}
        {run.status === "LOCKED" ? (
          <div className="rounded-md border border-stone-300 bg-stone-100 p-3 text-sm text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
            This payroll period is LOCKED — historical values are frozen and never recalculated (§27/§46).
          </div>
        ) : null}

        {/* §33 — summary */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard title="Status" value={humanize(run.status)} sub={`${run.employeeCount} employees`} />
          <StatCard title="Gross Payroll" value={money(run.grossCents)} sub="All earnings" />
          <StatCard title="Total Deductions" value={money(run.deductionsCents)} sub={`Statutory ${money(statutoryTotal)} · other ${money(otherTotal)}`} />
          <StatCard title="Employer Cost" value={money(run.employerCostCents)} sub="Not deducted from salaries (§23)" />
          <StatCard title="Net Payroll" value={money(run.netCents)} sub={run.paymentRef ? `Paid · ref ${run.paymentRef}` : run.payDate ? `Pay date ${fmtDate(run.payDate)}` : "—"} tone="success" />
        </div>

        {/* §44/§45 — review exceptions */}
        {run.review.exceptionCount > 0 ? (
          <Card className="border-amber-300 dark:border-amber-800">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" /> Payroll Exceptions ({run.review.exceptionCount}) — review before approval
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              {run.review.flaggedItems.map((f) => (
                <button key={f.id} className="flex w-full flex-wrap items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-amber-50 dark:hover:bg-amber-950/30" onClick={() => setSelected(run.items.find((i) => i.id === f.id) ?? null)}>
                  <span className="font-medium">{f.employeeNo} {f.employeeName}</span>
                  <span className="text-muted-foreground">net {money(f.netCents)}</span>
                  {f.flags.map((fl) => (
                    <span key={fl} className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">{FLAG_LABELS[fl] ?? fl}</span>
                  ))}
                </button>
              ))}
              {run.review.removedEmployees.map((r) => (
                <div key={r.employeeNo} className="flex flex-wrap items-center gap-2 rounded px-1 py-0.5">
                  <span className="font-medium">{r.employeeNo} {r.employeeName}</span>
                  <span className="text-muted-foreground">in previous run ({money(r.prevNetCents)}) but missing here</span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">Removed from payroll</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {/* §33 — employee payroll table */}
        {run.items.length === 0 ? (
          <EmptyState
            title={run.status === "DRAFT" ? "Payroll not calculated yet" : "No employee items"}
            hint={run.status === "DRAFT" ? "Use Calculate Payroll to run the engine for this period." : "This run has no calculated employees."}
            action={run.status === "DRAFT" && canManage ? <Button onClick={doCalculate} disabled={!!busy} data-testid="calc-empty-btn"><Calculator className="h-4 w-4 mr-2" />Calculate Payroll</Button> : undefined}
          />
        ) : (
          <DataTable<ItemRow>
            columns={itemColumns}
            rows={run.items}
            rowKey={(i) => i.id}
            onRowClick={(i) => setSelected(i)}
            searchPlaceholder="Search employee, department, position…"
            exportName={`payroll-items-${run.code}`}
            filters={[
              { key: "department", label: "Department", options: Array.from(new Set(run.items.map((i) => i.departmentName).filter(Boolean))).map((d) => ({ value: d, label: d })), match: (r, v) => r.departmentName === v },
              { key: "flags", label: "Exceptions", options: [{ value: "1", label: "Flagged only" }], match: (r) => r.flags.length > 0 },
            ]}
          />
        )}

        {/* §24 — adjustments */}
        {run.adjustments.length > 0 ? (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Adjustments ({run.adjustments.length})</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-1.5 text-sm">
                {run.adjustments.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={a.status} />
                    <span className="font-medium">{a.employeeNo ?? ""} {a.employeeName ?? ""}</span>
                    <span className={cn("font-medium", a.direction === "EARNING" ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
                      {a.direction === "EARNING" ? "+" : "−"}{money(a.amountCents)}
                    </span>
                    <span className="text-muted-foreground">{humanize(a.category)} · {a.reason}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {/* §34 — employee payroll detail with full traceability (§48) */}
      <ItemDetailDialog item={selected} run={run} onClose={() => setSelected(null)} />

      {/* Confirmation dialogs for irreversible transitions (§27/§39/§50) */}
      <AlertDialog open={!!confirmAction} onOpenChange={(o) => !o && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.label}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.action === "finalize"
                ? "After finalization the payroll values cannot be edited. Corrections use auditable adjustments only."
                : confirmAction?.action === "mark_paid"
                  ? "Confirms that salaries have actually been paid and records one payroll expense in the finance ledger."
                  : confirmAction?.action === "lock"
                    ? "Locking is permanent and restricted to SUPER_ADMIN."
                    : "This action is audited."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction?.action === "mark_paid" ? (
            <div className="space-y-1.5">
              <Label htmlFor="pay-ref">Payment reference (optional)</Label>
              <Input id="pay-ref" value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} placeholder="e.g. bank batch no." />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); if (confirmAction) void doTransition(confirmAction.action, confirmAction.action === "mark_paid" && paymentRef ? { paymentRef } : undefined); }}
              data-testid="confirm-transition"
            >
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null} Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}

// ── Employee items table columns (§33 — Position column, never Role) ────────

const itemColumns: Column<ItemRow>[] = [
  {
    key: "employee", header: "Employee", sortable: true, value: (i) => i.employeeName,
    render: (i) => (
      <div>
        <div className="font-medium">{i.employeeName}</div>
        <div className="text-xs text-muted-foreground">{i.employeeNo}</div>
      </div>
    ),
  },
  { key: "department", header: "Department", value: (i) => i.departmentName, hideOnMobile: true },
  { key: "position", header: "Position", value: (i) => i.positionName, hideOnMobile: true },
  { key: "basic", header: "Basic", sortable: true, value: (i) => i.basicCents, render: (i) => money(i.basicCents) },
  { key: "allowances", header: "Allowances", sortable: true, value: (i) => i.allowancesCents, render: (i) => money(i.allowancesCents), hideOnMobile: true },
  { key: "overtime", header: "Overtime", sortable: true, value: (i) => i.overtimeCents, render: (i) => money(i.overtimeCents), hideOnMobile: true },
  { key: "gross", header: "Gross", sortable: true, value: (i) => i.grossCents, render: (i) => money(i.grossCents) },
  { key: "deductions", header: "Deductions", sortable: true, value: (i) => i.deductionsCents, render: (i) => money(i.deductionsCents) },
  {
    key: "net", header: "Net", sortable: true, value: (i) => i.netCents,
    render: (i) => (
      <div className="flex items-center gap-1.5">
        <span className="font-medium">{money(i.netCents)}</span>
        {i.varianceBps != null && Math.abs(i.varianceBps) > 3000 ? (
          <span className={cn("text-[10px] font-semibold", i.varianceBps > 0 ? "text-emerald-600" : "text-red-600")}>
            {i.varianceBps > 0 ? "▲" : "▼"}{Math.abs(i.varianceBps / 100).toFixed(0)}%
          </span>
        ) : null}
      </div>
    ),
  },
  {
    key: "status", header: "Status",
    render: (i) => (
      <div className="flex items-center gap-1.5">
        <StatusBadge status={i.status} />
        {i.flags.length > 0 ? <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="Flagged for review" /> : null}
      </div>
    ),
  },
];

// ── Item detail dialog ──────────────────────────────────────────────────────

function ItemDetailDialog({ item, run, onClose }: { item: ItemRow | null; run: RunDetail; onClose: () => void }) {
  const { user } = useSession();
  const canReadAll = hasPerm(user, PERMISSIONS.payroll_read);
  if (!item) return null;
  const earnings = item.lines.filter((l) => l.kind === "EARNING");
  const deductions = item.lines.filter((l) => l.kind === "DEDUCTION");
  const employer = item.lines.filter((l) => l.kind === "EMPLOYER");

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] p-0" data-testid="item-dialog">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-lg">
            {item.employeeName} <span className="text-sm font-normal text-muted-foreground">{item.employeeNo} · {item.departmentName || "—"} · {item.positionName || "—"}</span>
          </DialogTitle>
          <DialogDescription>
            {run.name} · {fmtDate(run.periodStart)} – {fmtDate(run.periodEnd)} — every figure traces to a component (§48).
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[65vh] px-6 pb-6">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-5">
              <div><span className="block font-medium text-foreground">{item.workingDays}</span>working days</div>
              <div><span className="block font-medium text-foreground">{item.workedDays}</span>worked (att.)</div>
              <div><span className="block font-medium text-foreground">{item.paidLeaveDays}</span>paid leave</div>
              <div><span className="block font-medium text-foreground">{item.unpaidLeaveDays}</span>unpaid leave</div>
              <div><span className="block font-medium text-foreground">{(item.otMinutes / 60).toFixed(2)}</span>overtime h</div>
            </div>

            <LineTable title="Earnings" rows={earnings} emptyHint="No earnings." />
            <LineTable title="Deductions" rows={deductions} emptyHint="No deductions." />
            {employer.length > 0 ? <LineTable title="Employer Contributions (cost only)" rows={employer} emptyHint="" /> : null}

            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <Row label="Gross Pay" value={money(item.grossCents)} />
              <Row label="Total Deductions" value={`− ${money(item.deductionsCents)}`} />
              <Row label="Net Pay" value={money(item.netCents)} strong />
              {canReadAll && item.employerCostCents > 0 ? <Row label="Employer Cost (info)" value={money(item.employerCostCents)} /> : null}
            </div>

            {item.payslipObjectKey ? (
              <a href={`/api/v1/hr/payroll/items/${item.id}/payslip`} target="_blank" rel="noreferrer" data-testid="payslip-view">
                <Button variant="outline" className="w-full"><FileText className="h-4 w-4 mr-2" />View stored payslip PDF</Button>
              </a>
            ) : (
              <p className="text-xs text-muted-foreground">Payslip PDF is generated after the run is finalized (§9).</p>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function LineTable({ title, rows, emptyHint }: { title: string; rows: PayrollLine[]; emptyHint: string }) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((l) => (
                <tr key={l.code + l.label} className="border-b last:border-b-0">
                  <td className="px-3 py-1.5">
                    <span className="font-medium">{l.label}</span>
                    {l.basis ? <span className="ml-1.5 text-xs text-muted-foreground">({l.basis})</span> : null}
                    {l.detail ? <span className="block text-xs text-muted-foreground">{l.detail}</span> : null}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{money(l.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between py-0.5", strong && "border-t pt-1.5 mt-1.5 font-semibold")}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
