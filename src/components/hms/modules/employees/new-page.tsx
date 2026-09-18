"use client";

// MOHD.HMS ENTERPRISE — dedicated New Employee page (employees "new" view).
// Replaces the old create dialog. Same API (POST /api/v1/employees), same
// payload mapping (BND → cents), same server field-error mapping.
// No draft hook existed for this form — pageDirty is registered whenever the
// form differs from the initial empty state, cleared on unmount.

import { useEffect, useMemo, useState } from "react";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DepartmentField } from "./department-field";
import {
  EMPTY_FORM, FieldError, SalaryField, extractFieldErrors, payloadFor,
  type EmployeeRow, type FieldErrors, type FormState,
} from "./shared";

export function EmployeeNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canCreate = hasPerm(user, PERMISSIONS.employees_create);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  // ── Dirty-state wiring (central router guard + data protection) ──
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(EMPTY_FORM), [form]);
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function submitCreate() {
    setSaving(true);
    setFieldErrors({});
    try {
      const res = await api.post<EmployeeRow>("/api/v1/employees", payloadFor(form));
      toast({ title: "Employee added", description: `${res.data.firstName} ${res.data.lastName} (${res.data.employeeNo}).` });
      setForm(EMPTY_FORM);
      setPageDirty(false);
      navigateTo("employees");
    } catch (e) {
      // Keep every user-entered value on failure — show the error and allow retry.
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not add employee", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canCreate) {
    return (
      <PageShell
        backLabel="Back to Employees"
        backHref="/employees"
        crumbs={[{ label: "Employees", href: "/employees" }, { label: "New Employee" }]}
        title="New Employee"
      >
        <EmptyState
          title="You don't have permission to add employees"
          hint="Employee creation is limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const actions = (
    <>
      <Button variant="outline" onClick={() => navigateTo("employees")} disabled={saving}>Cancel</Button>
      <Button onClick={submitCreate} disabled={saving}>{saving ? "Creating…" : "Add employee"}</Button>
    </>
  );

  return (
    <PageShell
      backLabel="Back to Employees"
      backHref="/employees"
      crumbs={[{ label: "Employees", href: "/employees" }, { label: "New Employee" }]}
      title="New Employee"
      description="Employee number is generated automatically (EMP-YYYY-NNNN)."
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{actions}</div>}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); submitCreate(); }}
        className="max-w-3xl"
      >
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Employee details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="e-first">First name *</Label>
                <Input id="e-first" value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} />
                <FieldError msg={fieldErrors.firstName} />
              </div>
              <div>
                <Label htmlFor="e-last">Last name *</Label>
                <Input id="e-last" value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} />
                <FieldError msg={fieldErrors.lastName} />
              </div>
              <DepartmentField
                value={form.departmentId}
                onChange={(v) => set({ departmentId: v === "none" ? "" : v })}
                idPrefix="e"
              />
              <div>
                <Label htmlFor="e-position">Position</Label>
                <Input id="e-position" value={form.position} onChange={(e) => set({ position: e.target.value })} placeholder="e.g. HVAC Technician" />
              </div>
              <div>
                <Label htmlFor="e-email">Email</Label>
                <Input id="e-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
                <FieldError msg={fieldErrors.email} />
              </div>
              <div>
                <Label htmlFor="e-phone">Phone</Label>
                <Input id="e-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+673 7123456" />
              </div>
              <div>
                <Label htmlFor="e-join">Join date</Label>
                <Input id="e-join" type="date" value={form.joinDate} onChange={(e) => set({ joinDate: e.target.value })} />
                <FieldError msg={fieldErrors.joinDate} />
              </div>
              <SalaryField
                id="e-salary"
                label="Monthly salary (BND)"
                value={form.salary}
                onChange={(v) => set({ salary: v })}
                errors={fieldErrors}
              />
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
