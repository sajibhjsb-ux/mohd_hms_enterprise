"use client";

// MOHD.HMS ENTERPRISE — Employees module (HR staff directory).
// Departments come from the HR module endpoint; if that module has not landed
// yet the select degrades gracefully and department shows "—".

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import type { Permission } from "@/lib/hms/constants";
import { fmtDate, fromCents, money, toCents } from "@/lib/hms/format";
import { IdCard, Plus, Pencil, UserMinus, Wallet } from "lucide-react";

/** Exact list contract produced by /api/v1/employees (GET). */
type EmployeeRow = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string;
  email: string;
  phone: string;
  status: string;
  salaryCents: number;
  joinDate: string | null;
  departmentId: string | null;
  department: { id: string; name: string } | null;
};

type Department = { id: string; name: string; description?: string };

type FormState = {
  firstName: string; lastName: string; departmentId: string; position: string;
  email: string; phone: string; joinDate: string; salary: string; status: string;
};

const EMPTY_FORM: FormState = { firstName: "", lastName: "", departmentId: "", position: "", email: "", phone: "", joinDate: "", salary: "", status: "ACTIVE" };

type FieldErrors = Record<string, string>;
function extractFieldErrors(e: unknown): FieldErrors {
  if (e instanceof ClientApiError && Array.isArray(e.details)) {
    const out: FieldErrors = {};
    for (const d of e.details as { path?: string; message?: string }[]) {
      if (d?.path && d?.message) out[d.path] = d.message;
    }
    return out;
  }
  return {};
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive mt-1">{msg}</p>;
}

export function EmployeesModule() {
  const { user } = useSession();
  const { toast } = useToast();
  const can = (p: Permission) => !!user?.permissions.includes(p);

  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentsAvailable, setDepartmentsAvailable] = useState<boolean | null>(null); // null = probing

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const [editRow, setEditRow] = useState<EmployeeRow | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [editFieldErrors, setEditFieldErrors] = useState<FieldErrors>({});

  const [deleteRow, setDeleteRow] = useState<EmployeeRow | null>(null);

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

  const loadDepartments = useCallback(async () => {
    try {
      const res = await api.get<Department[]>("/api/v1/hr/departments");
      setDepartments(res.data ?? []);
      setDepartmentsAvailable(true);
    } catch {
      // HR module not landed yet — degrade gracefully.
      setDepartments([]);
      setDepartmentsAvailable(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadDepartments(); }, [loadDepartments]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setCreateOpen(true);
  };

  const openEdit = (row: EmployeeRow) => {
    setEditRow(row);
    setEditFieldErrors({});
    setEditForm({
      firstName: row.firstName,
      lastName: row.lastName,
      departmentId: row.departmentId ?? "",
      position: row.position,
      email: row.email,
      phone: row.phone,
      joinDate: row.joinDate ? row.joinDate.slice(0, 10) : "",
      salary: fromCents(row.salaryCents),
      status: row.status,
    });
  };

  function payloadFor(f: FormState) {
    return {
      firstName: f.firstName,
      lastName: f.lastName,
      departmentId: f.departmentId || null,
      position: f.position || undefined,
      email: f.email || undefined,
      phone: f.phone || undefined,
      joinDate: f.joinDate || undefined,
      salary: f.salary === "" ? undefined : toCents(f.salary), // ringgit → cents
      status: f.status as "ACTIVE" | "ON_LEAVE" | "TERMINATED",
    };
  }

  async function submitCreate() {
    setSaving(true);
    setFieldErrors({});
    try {
      const res = await api.post<EmployeeRow>("/api/v1/employees", payloadFor(form));
      toast({ title: "Employee added", description: `${res.data.firstName} ${res.data.lastName} (${res.data.employeeNo}).` });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      load();
    } catch (e) {
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not add employee", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit() {
    if (!editRow) return;
    setSaving(true);
    setEditFieldErrors({});
    try {
      await api.patch(`/api/v1/employees/${editRow.id}`, payloadFor(editForm));
      toast({ title: "Employee updated", description: `${editForm.firstName} ${editForm.lastName} saved.` });
      setEditRow(null);
      load();
    } catch (e) {
      setEditFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not update employee", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

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
          {can("employees.update") ? (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(r)} aria-label={`Edit ${r.firstName}`}>
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
          {can("employees.delete") && r.status !== "TERMINATED" ? (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setDeleteRow(r)} aria-label={`Terminate ${r.firstName}`}>
              <UserMinus className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ),
      className: "w-4",
    },
  ];

  const departmentSelect = (value: string, onChange: (v: string) => void, idPrefix: string, disabled?: boolean) => (
    <Select value={value || "none"} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={`${idPrefix}-dept`}><SelectValue placeholder={departmentsAvailable === false ? "HR module not available yet" : "Select department"} /></SelectTrigger>
      <SelectContent>
        <SelectItem value="none">— No department —</SelectItem>
        {departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle="Staff directory, positions and payroll baseline"
        actions={
          can("employees.create") ? (
            <Button onClick={openCreate}>
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
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
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
          ]}
          emptyTitle="No employees yet"
          emptyHint="Add your first employee to build the HR directory."
          exportName="employees"
        />
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New employee</DialogTitle>
            <DialogDescription>Employee number is generated automatically (EMP-YYYY-NNNN).</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="e-first">First name *</Label>
              <Input id="e-first" value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
              <FieldError msg={fieldErrors.firstName} />
            </div>
            <div>
              <Label htmlFor="e-last">Last name *</Label>
              <Input id="e-last" value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
              <FieldError msg={fieldErrors.lastName} />
            </div>
            <div>
              <Label htmlFor="e-dept">Department</Label>
              {departmentSelect(form.departmentId, (v) => setForm((f) => ({ ...f, departmentId: v === "none" ? "" : v })), "e")}
              {departmentsAvailable === false ? <p className="text-xs text-muted-foreground mt-1">HR module hasn&apos;t published departments yet — you can still add the employee.</p> : null}
            </div>
            <div>
              <Label htmlFor="e-position">Position</Label>
              <Input id="e-position" value={form.position} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} placeholder="e.g. HVAC Technician" />
            </div>
            <div>
              <Label htmlFor="e-email">Email</Label>
              <Input id="e-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              <FieldError msg={fieldErrors.email} />
            </div>
            <div>
              <Label htmlFor="e-phone">Phone</Label>
              <Input id="e-phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="e-join">Join date</Label>
              <Input id="e-join" type="date" value={form.joinDate} onChange={(e) => setForm((f) => ({ ...f, joinDate: e.target.value }))} />
              <FieldError msg={fieldErrors.joinDate} />
            </div>
            <div>
              <Label htmlFor="e-salary">Monthly salary (MYR)</Label>
              <Input id="e-salary" inputMode="decimal" value={form.salary} onChange={(e) => setForm((f) => ({ ...f, salary: e.target.value }))} placeholder="e.g. 3500.00" />
              {form.salary !== "" && !isNaN(parseFloat(form.salary)) ? (
                <p className="text-xs text-muted-foreground mt-1">Stored as {toCents(form.salary).toLocaleString()} cents</p>
              ) : null}
              <FieldError msg={fieldErrors.salary} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={saving}>{saving ? "Creating…" : "Add employee"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit {editRow?.firstName} {editRow?.lastName}</DialogTitle>
            <DialogDescription>{editRow?.employeeNo} · employee number cannot be changed.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="ee-first">First name</Label>
              <Input id="ee-first" value={editForm.firstName} onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))} />
              <FieldError msg={editFieldErrors.firstName} />
            </div>
            <div>
              <Label htmlFor="ee-last">Last name</Label>
              <Input id="ee-last" value={editForm.lastName} onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))} />
              <FieldError msg={editFieldErrors.lastName} />
            </div>
            <div>
              <Label htmlFor="ee-dept">Department</Label>
              {departmentSelect(editForm.departmentId, (v) => setEditForm((f) => ({ ...f, departmentId: v === "none" ? "" : v })), "ee")}
            </div>
            <div>
              <Label htmlFor="ee-position">Position</Label>
              <Input id="ee-position" value={editForm.position} onChange={(e) => setEditForm((f) => ({ ...f, position: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="ee-email">Email</Label>
              <Input id="ee-email" type="email" value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
              <FieldError msg={editFieldErrors.email} />
            </div>
            <div>
              <Label htmlFor="ee-phone">Phone</Label>
              <Input id="ee-phone" value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="ee-join">Join date</Label>
              <Input id="ee-join" type="date" value={editForm.joinDate} onChange={(e) => setEditForm((f) => ({ ...f, joinDate: e.target.value }))} />
              <FieldError msg={editFieldErrors.joinDate} />
            </div>
            <div>
              <Label htmlFor="ee-salary">Monthly salary (MYR)</Label>
              <Input id="ee-salary" inputMode="decimal" value={editForm.salary} onChange={(e) => setEditForm((f) => ({ ...f, salary: e.target.value }))} />
              <FieldError msg={editFieldErrors.salary} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="ee-status">Status</Label>
              <Select value={editForm.status} onValueChange={(v) => setEditForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger id="ee-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="ON_LEAVE">On leave</SelectItem>
                  <SelectItem value="TERMINATED">Terminated</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Terminate confirm */}
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
