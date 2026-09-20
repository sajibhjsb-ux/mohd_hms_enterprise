"use client";

// MOHD.HMS ENTERPRISE — Employees module shared form pieces.
// Used by the dedicated New Employee page (new-page.tsx) and Edit Employee
// page (edit-page.tsx). Field ids, payload mapping (BND → cents) and
// server field-error mapping are identical to the original dialogs.
// POSITION (role/position spec): the job title comes from the managed
// position catalog (positionId) — the free-text `position` field is a
// server-side snapshot used by letters/attendance/profile.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClientApiError } from "@/lib/hms/api-client";
import { fromCents, toCents } from "@/lib/hms/format";

/** Exact list contract produced by /api/v1/employees (GET). */
export type EmployeeRow = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string;
  positionId: string | null;
  positionRef: { id: string; name: string; status: string } | null;
  email: string;
  phone: string;
  status: string;
  salaryCents: number;
  joinDate: string | null;
  departmentId: string | null;
  department: { id: string; name: string } | null;
  /** Linked account's application role (authorization axis, §19 filter). */
  user?: { role: string } | null;
};

export type FormState = {
  firstName: string; lastName: string; departmentId: string; positionId: string;
  email: string; phone: string; joinDate: string; salary: string; status: string;
};

export const EMPTY_FORM: FormState = { firstName: "", lastName: "", departmentId: "", positionId: "", email: "", phone: "", joinDate: "", salary: "", status: "ACTIVE" };

/** Prefill an edit form from a list/detail row (employee number is not editable). */
export function formFromRow(row: EmployeeRow): FormState {
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    departmentId: row.departmentId ?? "",
    positionId: row.positionId ?? "",
    email: row.email,
    phone: row.phone,
    joinDate: row.joinDate ? row.joinDate.slice(0, 10) : "",
    salary: fromCents(row.salaryCents),
    status: row.status,
  };
}

export function payloadFor(f: FormState) {
  return {
    firstName: f.firstName,
    lastName: f.lastName,
    departmentId: f.departmentId || null,
    positionId: f.positionId || null,
    email: f.email || undefined,
    phone: f.phone || undefined,
    joinDate: f.joinDate || undefined,
    salary: f.salary === "" ? undefined : toCents(f.salary), // BND → cents
    status: f.status as "ACTIVE" | "ON_LEAVE" | "TERMINATED",
  };
}

export type FieldErrors = Record<string, string>;

export function extractFieldErrors(e: unknown): FieldErrors {
  if (e instanceof ClientApiError && Array.isArray(e.details)) {
    const out: FieldErrors = {};
    for (const d of e.details as { path?: string; message?: string }[]) {
      if (d?.path && d?.message) out[d.path] = d.message;
    }
    return out;
  }
  return {};
}

export function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive mt-1">{msg}</p>;
}

/** Salary helper: cents preview under the BND input (kept from the dialogs). */
export function SalaryField({
  id, label, value, onChange, errors,
}: { id: string; label: string; value: string; onChange: (v: string) => void; errors?: FieldErrors }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. 3500.00" />
      {value !== "" && !isNaN(parseFloat(value)) ? (
        <p className="text-xs text-muted-foreground mt-1">Stored as {toCents(value).toLocaleString()} cents</p>
      ) : null}
      {errors ? <FieldError msg={errors.salary} /> : null}
    </div>
  );
}
