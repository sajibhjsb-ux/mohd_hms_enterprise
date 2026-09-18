"use client";

// MOHD.HMS ENTERPRISE — dedicated Edit Employee page (employees "edit" view,
// also served for the "detail" view which has no page of its own).
// Replaces the old edit dialog. Same API (PATCH /api/v1/employees/{id}), same
// payload mapping and server field-error mapping. Employee number is shown
// read-only in the description — it cannot be changed.
//
// PREFILL APPROACH (documented): the employees API DOES expose a direct detail
// endpoint — GET /api/v1/employees/{id} returns the same contract as list
// items (plus a `user` include), so we fetch the record directly instead of
// loading the list and finding by id. No new APIs were added.

import { useCallback, useEffect, useState } from "react";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DepartmentField } from "./department-field";
import {
  FieldError, SalaryField, extractFieldErrors, formFromRow, payloadFor,
  type EmployeeRow, type FieldErrors, type FormState,
} from "./shared";

export function EmployeeEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canUpdate = hasPerm(user, PERMISSIONS.employees_update);

  const [row, setRow] = useState<EmployeeRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<EmployeeRow>(`/api/v1/employees/${id}`);
      setRow(res.data);
      const f = formFromRow(res.data);
      setForm(f);
      setInitial(f);
    } catch (e) {
      setRow(null);
      setLoadError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // ── Dirty-state wiring (central router guard + data protection) ──
  const dirty = !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial);
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function submitEdit() {
    if (!row || !form) return;
    setSaving(true);
    setFieldErrors({});
    try {
      await api.patch(`/api/v1/employees/${row.id}`, payloadFor(form));
      toast({ title: "Employee updated", description: `${form.firstName} ${form.lastName} saved.` });
      setPageDirty(false);
      navigateTo("employees");
    } catch (e) {
      // Keep every user-entered value on failure — show the error and allow retry.
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not update employee", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canUpdate) {
    return (
      <PageShell
        backLabel="Back to Employees"
        backHref="#/employees"
        crumbs={[{ label: "Employees", href: "#/employees" }, { label: "Edit" }]}
        title="Edit Employee"
      >
        <EmptyState
          title="You don't have permission to edit employees"
          hint="Employee updates are limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const displayName = row ? `${row.firstName} ${row.lastName}` : "Employee";

  if (loading && !row) {
    return (
      <PageShell backLabel="Back to Employees" backHref="#/employees" title="Edit Employee">
        <LoadingState label="Loading employee…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !row) {
    return (
      <PageShell backLabel="Back to Employees" backHref="#/employees" title="Edit Employee">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!row || !form) {
    return (
      <PageShell backLabel="Back to Employees" backHref="#/employees" title="Edit Employee">
        <EmptyState title="Employee not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const set = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const actions = (
    <>
      <Button variant="outline" onClick={() => navigateTo("employees")} disabled={saving}>Cancel</Button>
      <Button onClick={submitEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
    </>
  );

  return (
    <PageShell
      backLabel="Back to Employees"
      backHref="#/employees"
      crumbs={[
        { label: "Employees", href: "#/employees" },
        { label: row.employeeNo || displayName },
        { label: "Edit" },
      ]}
      title={`Edit ${displayName}`}
      description={`${row.employeeNo} · employee number cannot be changed.`}
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{actions}</div>}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); submitEdit(); }}
        className="max-w-3xl"
      >
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Employee details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="ee-first">First name</Label>
                <Input id="ee-first" value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} />
                <FieldError msg={fieldErrors.firstName} />
              </div>
              <div>
                <Label htmlFor="ee-last">Last name</Label>
                <Input id="ee-last" value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} />
                <FieldError msg={fieldErrors.lastName} />
              </div>
              <DepartmentField
                value={form.departmentId}
                onChange={(v) => set({ departmentId: v === "none" ? "" : v })}
                idPrefix="ee"
              />
              <div>
                <Label htmlFor="ee-position">Position</Label>
                <Input id="ee-position" value={form.position} onChange={(e) => set({ position: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="ee-email">Email</Label>
                <Input id="ee-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
                <FieldError msg={fieldErrors.email} />
              </div>
              <div>
                <Label htmlFor="ee-phone">Phone</Label>
                <Input id="ee-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+673 7123456" />
              </div>
              <div>
                <Label htmlFor="ee-join">Join date</Label>
                <Input id="ee-join" type="date" value={form.joinDate} onChange={(e) => set({ joinDate: e.target.value })} />
                <FieldError msg={fieldErrors.joinDate} />
              </div>
              <SalaryField
                id="ee-salary"
                label="Monthly salary (BND)"
                value={form.salary}
                onChange={(v) => set({ salary: v })}
                errors={fieldErrors}
              />
              <div className="sm:col-span-2">
                <Label htmlFor="ee-status">Status</Label>
                <Select value={form.status} onValueChange={(v) => set({ status: v })}>
                  <SelectTrigger id="ee-status" className="sm:max-w-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="ON_LEAVE">On leave</SelectItem>
                    <SelectItem value="TERMINATED">Terminated</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Mobile-visible action row (desktop actions live in the header) */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4 sm:hidden">
              {actions}
            </div>
          </CardContent>
        </Card>
      </form>
    </PageShell>
  );
}
