"use client";

// MOHD.HMS ENTERPRISE — shared Department select for employee forms.
// Departments come from the HR module endpoint (/api/v1/hr/departments); if
// that module has not landed yet the select degrades gracefully and the
// employee can still be saved without a department.

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/hms/api-client";

export type Department = { id: string; name: string; description?: string };

/** Probe the HR departments endpoint once per mount; degrades when unavailable. */
export function useDepartments(): { departments: Department[]; available: boolean | null } {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null); // null = probing

  useEffect(() => {
    let alive = true;
    api.get<Department[]>("/api/v1/hr/departments")
      .then((r) => { if (alive) { setDepartments(r.data ?? []); setAvailable(true); } })
      .catch(() => {
        // HR module not landed yet — degrade gracefully.
        if (alive) { setDepartments([]); setAvailable(false); }
      });
    return () => { alive = false; };
  }, []);

  return { departments, available };
}

/**
 * Shared department field — `departmentSelect(value, onChange, idPrefix, disabled?)`
 * from the original dialogs, now as a component used by both employee pages.
 */
export function DepartmentField({
  value, onChange, idPrefix, disabled,
}: { value: string; onChange: (v: string) => void; idPrefix: string; disabled?: boolean }) {
  const { departments, available } = useDepartments();
  return (
    <div>
      <Label htmlFor={`${idPrefix}-dept`}>Department</Label>
      <Select value={value || "none"} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={`${idPrefix}-dept`}>
          <SelectValue placeholder={available === false ? "HR module not available yet" : "Select department"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">— No department —</SelectItem>
          {departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
        </SelectContent>
      </Select>
      {available === false ? (
        <p className="text-xs text-muted-foreground mt-1">
          HR module hasn&apos;t published departments yet — you can still save the employee.
        </p>
      ) : null}
    </div>
  );
}
