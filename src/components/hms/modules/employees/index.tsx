"use client";

// MOHD.HMS ENTERPRISE — Employees module (HR staff directory).
//
// NAVIGATION ARCHITECTURE: employee create / edit are DEDICATED PAGES routed
// by the hash router (ui-store pages["employees"]) — no popup CRUD:
//   []                  → this list page
//   ["new"]             → EmployeeNewPage
//   [id]                → detail view → falls back to the edit page
//                         (employees have no separate detail page)
//   [id, "edit"]        → EmployeeEditPage
// The only remaining dialog is the Terminate confirmation (AlertDialog),
// which is a confirm, not a form.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { fmtDate, money } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { IdCard, Plus, Pencil, UserMinus, Wallet } from "lucide-react";
import { EmployeeNewPage } from "./new-page";
import { EmployeeEditPage } from "./edit-page";
import type { EmployeeRow } from "./shared";

// ── Module router ──

export function EmployeesModule() {
  const seg = useUi((s) => s.pages["employees"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "new") return <EmployeeNewPage />;
  // "detail" view falls back to the edit page — employees have no separate detail page.
  if ((page.view === "edit" || page.view === "detail") && page.id) return <EmployeeEditPage id={page.id} />;
  return <EmployeesList />;
}

// ── List page ──

function EmployeesList() {
  const { user } = useSession();
  const { toast } = useToast();
  const canCreate = hasPerm(user, PERMISSIONS.employees_create);
  const canUpdate = hasPerm(user, PERMISSIONS.employees_update);
  const canDelete = hasPerm(user, PERMISSIONS.employees_delete);

  // All page navigation flows through the hash router (URL + Back/Forward).
  const openPage = useCallback((seg: string[]) => navigateTo("employees", seg), []);

  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [deleteRow, setDeleteRow] = useState<EmployeeRow | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<EmployeeRow[]>(`/api/v1/employees${qs({ pageSize: 200 })}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime: employee/HR changes refresh the list live.
  useRealtimeEvent(MODULE_EVENTS.employees, () => { void load(); });

  // Terminate stays a confirm dialog (soft delete — history is retained).
  async function submitDelete() {
    if (!deleteRow) return;
    setSaving(true);
    try {
      await api.del(`/api/v1/employees/${deleteRow.id}`);
      toast({ title: "Employee terminated", description: `${deleteRow.firstName} ${deleteRow.lastName} is now marked TERMINATED. History is retained.` });
      setDeleteRow(null);
      load();
    } catch (e) {
      toast({ title: "Could not terminate employee", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const activeCount = rows.filter((r) => r.status === "ACTIVE").length;
  const onLeaveCount = rows.filter((r) => r.status === "ON_LEAVE").length;
  const payrollCents = rows.filter((r) => r.status !== "TERMINATED").reduce((s, r) => s + r.salaryCents, 0);

  const columns: Column<EmployeeRow>[] = [
    { key: "employeeNo", header: "Emp No.", value: (r) => r.employeeNo, className: "font-mono text-xs whitespace-nowrap" },
    {
      key: "name", header: "Employee", value: (r) => `${r.firstName} ${r.lastName}`,
      render: (r) => (
        <div className="min-w-[140px]">
          <div className="font-medium truncate">{r.firstName} {r.lastName}</div>
          <div className="text-xs text-muted-foreground truncate">{r.position || "—"}</div>
        </div>
      ),
    },
    {
      key: "department", header: "Department", value: (r) => r.department?.name ?? "",
      render: (r) => r.department?.name ?? "—",
      hideOnMobile: true,
    },
    {
      key: "contact", header: "Contact", value: (r) => `${r.email} ${r.phone}`,
      render: (r) => (
        <div className="min-w-[140px]">
          <div className="text-sm truncate">{r.email || "—"}</div>
          <div className="text-xs text-muted-foreground">{r.phone || ""}</div>
        </div>
      ),
      hideOnMobile: true,
    },
    { key: "salary", header: "Salary", value: (r) => r.salaryCents, render: (r) => money(r.salaryCents), hideOnMobile: true },
    { key: "joinDate", header: "Joined", value: (r) => r.joinDate ?? "", render: (r) => fmtDate(r.joinDate), hideOnMobile: true },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "actions", header: "", sortable: false,
      render: (r) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {canUpdate ? (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openPage([r.id, "edit"])} aria-label={`Edit ${r.firstName}`}>
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
          {canDelete && r.status !== "TERMINATED" ? (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setDeleteRow(r)} aria-label={`Terminate ${r.firstName}`}>
              <UserMinus className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ),
      className: "w-4",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle="Staff directory, positions and payroll baseline"
        actions={
          canCreate ? (
            <Button onClick={() => openPage(["new"])}>
              <Plus className="h-4 w-4 mr-1.5" /> New Employee
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard title="Employees" value={rows.length} icon={<IdCard className="h-5 w-5" />} loading={loading} />
        <StatCard title="Active" value={activeCount} tone="success" loading={loading} />
        <StatCard title="On leave" value={onLeaveCount} tone="warning" loading={loading} />
        <StatCard title="Monthly payroll" value={money(payrollCents)} icon={<Wallet className="h-5 w-5" />} loading={loading} />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <LoadingState label="Loading employees…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No employees yet"
          hint={canCreate ? "Add your first employee to build the HR directory." : "Employees will appear here once added."}
          action={canCreate ? (
            <Button variant="outline" onClick={() => openPage(["new"])}>
              <Plus className="h-4 w-4 mr-1.5" /> New Employee
            </Button>
          ) : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => openPage([r.id])}
          searchPlaceholder="Search name, number, email…"
          filters={[
            {
              key: "status", label: "Status",
              options: [
                { value: "ACTIVE", label: "Active" },
                { value: "ON_LEAVE", label: "On leave" },
                { value: "TERMINATED", label: "Terminated" },
              ],
              match: (r, v) => r.status === v,
            },
            {
              // Role filter (role/position spec §19) — the linked account's
              // application role, NOT the job title.
              key: "role", label: "Role",
              options: ["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "FINANCE", "HR"].map((r) => ({ value: r, label: humanize(r) })),
              match: (r, v) => r.user?.role === v,
            },
            {
              // Position filter — managed job titles actually in use.
              key: "position", label: "Position",
              options: [...new Set(rows.map((r) => r.positionRef?.name ?? r.position).filter((n): n is string => !!n))].sort().map((n) => ({ value: n, label: n })),
              match: (r, v) => (r.positionRef?.name ?? r.position) === v,
            },
            {
              key: "department", label: "Department",
              options: [...new Set(rows.map((r) => r.department?.name).filter((n): n is string => !!n))].sort().map((n) => ({ value: n, label: n })),
              match: (r, v) => r.department?.name === v,
            },
          ]}
          emptyTitle="No employees match"
          emptyHint="Adjust the search or filters to find the employee."
          exportName="employees"
        />
      )}

      {/* Terminate confirm — the only remaining dialog (a confirm, not a form). */}
      <AlertDialog open={!!deleteRow} onOpenChange={(o) => !o && setDeleteRow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Terminate {deleteRow?.firstName} {deleteRow?.lastName}?</AlertDialogTitle>
            <AlertDialogDescription>
              The record is kept and marked TERMINATED (soft delete) so attendance, leave and payroll history remain intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={saving} onClick={(e) => { e.preventDefault(); submitDelete(); }}>
              {saving ? "Working…" : "Terminate employee"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
