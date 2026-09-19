"use client";

// MOHD.HMS ENTERPRISE — dedicated Mark/Edit Attendance page (hr/attendance view).
// Replaces the former "Mark Attendance" dialog. Routing (hash router):
//   /hr/attendance/new    → create — defaults to today's date
//   /hr/attendance/{id}   → edit — prefilled from the attendance record
//
// The record id alone doesn't carry its date, so the edit page pulls the
// attendance list (the same GET /api/v1/hr/attendance endpoint the register
// tab uses, as a recent-window range: 1 year back → 30 days ahead) and finds
// the record client-side. Edit targets are near-term register entries, so
// this window is effectively always sufficient; outside it we show an honest
// "not found" state.
// POST /api/v1/hr/attendance stays an idempotent upsert (employee+day) — no new APIs.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { toDateInput } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Loader2, Save } from "lucide-react";

// ── Types ──

type Employee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string;
  status: string;
};

type AttendanceRecord = {
  id: string;
  date: string;
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  notes: string;
  employee: { id: string; firstName: string; lastName: string; employeeNo: string; position?: string };
};

type MarkForm = {
  employeeId: string;
  date: string;
  status: string;
  checkIn: string;
  checkOut: string;
  notes: string;
};

const ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "LEAVE", "HALF_DAY"];
const TIME_STATUSES = ["PRESENT", "HALF_DAY"];

const emptyForm = (): MarkForm => ({
  employeeId: "",
  date: toDateInput(new Date()),
  status: "PRESENT",
  checkIn: "08:00",
  checkOut: "17:00",
  notes: "",
});

// ── Page ──

export function HrAttendancePage({ attendanceId }: { attendanceId: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.hr_manage);
  const canReadEmployees = hasPerm(user, PERMISSIONS.employees_read) || canManage;
  const isEdit = attendanceId !== "new";

  // ── Form state (prefilled in edit mode once the record is located) ──
  const [form, setForm] = useState<MarkForm>(emptyForm);
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(emptyForm()));
  const [errors, setErrors] = useState<{ employeeId?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => JSON.stringify(form) !== baseline, [form, baseline]);
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  // ── Employees (same source as the register tab) ──
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [employeesError, setEmployeesError] = useState<string | null>(null);

  const loadEmployees = useCallback(async () => {
    if (!canReadEmployees) return;
    setEmployeesError(null);
    try {
      const res = await api.get<Employee[]>(`/api/v1/employees${qs({ pageSize: "200" })}`);
      setEmployees(res.data ?? []);
    } catch (e) {
      setEmployees(null);
      setEmployeesError(e instanceof Error ? e.message : "Employees register is unavailable.");
    }
  }, [canReadEmployees]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  const employeeOptions = useMemo(
    () => (employees ?? []).map((e) => ({ id: e.id, label: `${e.firstName} ${e.lastName} (${e.employeeNo})` })),
    [employees]
  );

  // ── Edit mode: locate the attendance record (see header comment) ──
  const [recordLoading, setRecordLoading] = useState(isEdit);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordMissing, setRecordMissing] = useState(false);

  const loadRecord = useCallback(async () => {
    setRecordLoading(true);
    setRecordError(null);
    setRecordMissing(false);
    try {
      const now = Date.now();
      const from = toDateInput(new Date(now - 366 * 86400000));
      const to = toDateInput(new Date(now + 30 * 86400000));
      const res = await api.get<AttendanceRecord[]>(`/api/v1/hr/attendance${qs({ from, to })}`);
      const rec = (res.data ?? []).find((a) => a.id === attendanceId);
      if (!rec) {
        setRecordMissing(true);
        return;
      }
      // Same prefill mapping the old dialog used (openMark).
      const prefill: MarkForm = {
        employeeId: rec.employee.id,
        date: toDateInput(rec.date),
        status: rec.status,
        checkIn: rec.checkIn ? new Date(rec.checkIn).toTimeString().slice(0, 5) : "08:00",
        checkOut: rec.checkOut ? new Date(rec.checkOut).toTimeString().slice(0, 5) : "17:00",
        notes: rec.notes ?? "",
      };
      setForm(prefill);
      setBaseline(JSON.stringify(prefill));
    } catch (e) {
      setRecordError(e instanceof Error ? e.message : "Could not load the attendance record.");
    } finally {
      setRecordLoading(false);
    }
  }, [attendanceId]);

  useEffect(() => {
    if (!isEdit) return;
    void loadRecord();
  }, [isEdit, loadRecord]);

  // ── Save (idempotent upsert) ──
  async function save() {
    if (!form.employeeId) {
      setErrors({ employeeId: "Select an employee." });
      toast({ title: "Select an employee", variant: "destructive" });
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      // Preserve the old "updated vs marked" toast nuance: the endpoint is an
      // idempotent upsert, so check whether this employee already has a record
      // for the chosen day (best-effort — default to "marked" on lookup failure).
      let existing = false;
      try {
        const day = await api.get<AttendanceRecord[]>(`/api/v1/hr/attendance${qs({ date: form.date })}`);
        existing = (day.data ?? []).some((a) => a.employee.id === form.employeeId);
      } catch { /* best-effort */ }
      await api.post("/api/v1/hr/attendance", {
        employeeId: form.employeeId,
        date: form.date,
        status: form.status,
        checkIn: TIME_STATUSES.includes(form.status) ? form.checkIn || null : null,
        checkOut: TIME_STATUSES.includes(form.status) ? form.checkOut || null : null,
        notes: form.notes || null,
      });
      toast({
        title: existing ? "Attendance updated" : "Attendance marked",
        description: `${humanize(form.status)} on ${form.date}.`,
      });
      setPageDirty(false);
      navigateTo("hr");
    } catch (e) {
      // Keep every entered value — the error banner allows an immediate retry.
      const msg = e instanceof Error ? e.message : "Could not mark attendance. Please try again.";
      setSubmitError(msg);
      toast({ title: "Could not mark attendance", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── RBAC guard ──
  if (!canManage) {
    return (
      <PageShell
        backLabel="Back to HR" backHref="/hr"
        crumbs={[{ label: "HR", href: "/hr" }, { label: "Attendance" }, { label: "Mark Attendance" }]}
        title="Mark Attendance"
      >
        <EmptyState
          title="You don't have permission to mark attendance"
          hint="Attendance marking requires the hr.manage permission. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  // ── Edit-mode load states ──
  if (isEdit && recordLoading) {
    return (
      <PageShell
        backLabel="Back to HR" backHref="/hr"
        crumbs={[{ label: "HR", href: "/hr" }, { label: "Attendance" }, { label: "Edit Attendance" }]}
        title="Edit Attendance"
      >
        <LoadingState label="Loading attendance record…" rows={3} />
      </PageShell>
    );
  }
  if (isEdit && recordError) {
    return (
      <PageShell
        backLabel="Back to HR" backHref="/hr"
        crumbs={[{ label: "HR", href: "/hr" }, { label: "Attendance" }, { label: "Edit Attendance" }]}
        title="Edit Attendance"
      >
        <ErrorState message={recordError} onRetry={() => void loadRecord()} />
      </PageShell>
    );
  }
  if (isEdit && recordMissing) {
    return (
      <PageShell
        backLabel="Back to HR" backHref="/hr"
        crumbs={[{ label: "HR", href: "/hr" }, { label: "Attendance" }, { label: "Edit Attendance" }]}
        title="Edit Attendance"
      >
        <EmptyState
          title="Attendance record not found"
          hint="It may be outside the recent records window, already replaced by a newer entry, or the link is incorrect."
        />
      </PageShell>
    );
  }

  const employeeLabel = employeeOptions.find((o) => o.id === form.employeeId)?.label;
  const title = isEdit ? "Edit Attendance" : "Mark Attendance";
  const description = isEdit
    ? employeeLabel
      ? `Updating ${employeeLabel} · ${form.date}. Saving updates the existing record for that employee and day.`
      : "Saving updates the existing record for the selected employee and day."
    : "Recording is idempotent — marking the same employee and day again updates the record.";

  const saveButton = (
    <Button onClick={() => void save()} disabled={saving || (employees === null && employeeOptions.length === 0)} className="flex-1 sm:flex-none">
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
      {saving ? "Saving…" : "Save Attendance"}
    </Button>
  );

  return (
    <div>
      <PageShell
        backLabel="Back to HR" backHref="/hr"
        crumbs={[{ label: "HR", href: "/hr" }, { label: "Attendance" }, { label: title }]}
        title={title}
        description={description}
        actions={employeesError ? undefined : <div className="hidden sm:flex items-center gap-2 no-print">{saveButton}</div>}
      >
        {submitError ? (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">Attendance could not be saved.</p>
              <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
            </div>
          </div>
        ) : null}

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Attendance Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {employeesError ? (
              <ErrorState
                message={`Employee options are unavailable — ${employeesError}`}
                onRetry={() => void loadEmployees()}
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Employee *</Label>
                  <Select
                    value={form.employeeId || undefined}
                    onValueChange={(v) => { setForm((f) => ({ ...f, employeeId: v })); setErrors((p) => ({ ...p, employeeId: undefined })); }}
                  >
                    <SelectTrigger aria-label="Employee">
                      <SelectValue placeholder={employeeOptions.length === 0 ? "Employee list unavailable" : "Select employee"} />
                    </SelectTrigger>
                    <SelectContent>
                      {employeeOptions.map((o) => (
                        <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.employeeId ? <p className="text-xs text-destructive">{errors.employeeId}</p> : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="att-date">Date</Label>
                  <Input id="att-date" type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                    <SelectTrigger aria-label="Attendance status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ATTENDANCE_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="att-in">Check In</Label>
                  <Input
                    id="att-in" type="time" value={form.checkIn}
                    onChange={(e) => setForm((f) => ({ ...f, checkIn: e.target.value }))}
                    disabled={!TIME_STATUSES.includes(form.status)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="att-out">Check Out</Label>
                  <Input
                    id="att-out" type="time" value={form.checkOut}
                    onChange={(e) => setForm((f) => ({ ...f, checkOut: e.target.value }))}
                    disabled={!TIME_STATUSES.includes(form.status)}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="att-notes">Notes</Label>
                  <Textarea
                    id="att-notes" rows={2} value={form.notes}
                    onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="Optional remarks…"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </PageShell>

      {/* Sticky mobile action bar */}
      {!employeesError ? (
        <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
          <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
            {saveButton}
          </div>
        </div>
      ) : null}
    </div>
  );
}
