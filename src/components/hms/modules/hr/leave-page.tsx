"use client";

// MOHD.HMS ENTERPRISE — dedicated New Leave Request page (hr/leave view).
// Replaces the former leave dialog. Routing: #/hr/leave/new.
// canFileForOthers logic kept exactly: managers/admins may file for any
// employee (or leave the employee blank to file for themselves); everyone else
// files against their own employee record. POST /api/v1/hr/leave — no new APIs.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
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
import { AlertCircle, CalendarPlus, Loader2, Send } from "lucide-react";

// ── Types ──

type Employee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string;
  status: string;
};

type LeaveForm = {
  employeeId: string;
  type: string;
  startDate: string;
  endDate: string;
  reason: string;
};

const LEAVE_TYPES = ["ANNUAL", "SICK", "UNPAID", "OTHER"];

const emptyForm = (): LeaveForm => ({
  employeeId: "",
  type: "ANNUAL",
  startDate: toDateInput(new Date()),
  endDate: toDateInput(new Date()),
  reason: "",
});

// ── Page ──

export function HrLeaveNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.hr_manage);
  // Exactly the old rule: managers/admins may file on behalf of others.
  const canFileForOthers = canManage || user?.role === "SUPER_ADMIN" || user?.role === "ADMIN";

  const [form, setForm] = useState<LeaveForm>(emptyForm);
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(emptyForm()));
  const [errors, setErrors] = useState<{ endDate?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => JSON.stringify(form) !== baseline, [form, baseline]);
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  // ── Employees (only needed to file for others) ──
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [employeesError, setEmployeesError] = useState<string | null>(null);

  const loadEmployees = useCallback(async () => {
    if (!canFileForOthers) return;
    setEmployeesError(null);
    try {
      const res = await api.get<Employee[]>(`/api/v1/employees${qs({ pageSize: "200" })}`);
      setEmployees(res.data ?? []);
    } catch (e) {
      setEmployees(null);
      setEmployeesError(e instanceof Error ? e.message : "Employees register is unavailable.");
    }
  }, [canFileForOthers]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  const employeeOptions = useMemo(
    () => (employees ?? []).map((e) => ({ id: e.id, label: `${e.firstName} ${e.lastName} (${e.employeeNo})` })),
    [employees]
  );

  // ── Submit ──
  async function save() {
    if (form.endDate < form.startDate) {
      setErrors({ endDate: "End date cannot be before start date." });
      toast({ title: "End date cannot be before start date", variant: "destructive" });
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      await api.post("/api/v1/hr/leave", {
        employeeId: canFileForOthers && form.employeeId ? form.employeeId : undefined,
        type: form.type,
        startDate: form.startDate,
        endDate: form.endDate,
        reason: form.reason,
      });
      toast({ title: "Leave request submitted", description: "It is now pending approval." });
      setPageDirty(false);
      navigateTo("hr");
    } catch (e) {
      // Keep every entered value — the error banner allows an immediate retry.
      const msg = e instanceof Error ? e.message : "Could not submit the request. Please try again.";
      setSubmitError(msg);
      toast({ title: "Could not submit request", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const submitButton = (
    <Button onClick={() => void save()} disabled={saving} className="flex-1 sm:flex-none">
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
      {saving ? "Submitting…" : "Submit Request"}
    </Button>
  );

  return (
    <div>
      <PageShell
        backLabel="Back to HR" backHref="#/hr"
        crumbs={[{ label: "HR", href: "#/hr" }, { label: "Leave" }, { label: "New Leave Request" }]}
        title="New Leave Request"
        description={
          canFileForOthers
            ? "File on behalf of any employee, or leave the employee blank to file for yourself."
            : "The request will be filed against your own employee record and sent for approval."
        }
        actions={<div className="hidden sm:flex items-center gap-2 no-print">{submitButton}</div>}
      >
        {submitError ? (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">The request could not be submitted.</p>
              <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
            </div>
          </div>
        ) : null}

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarPlus className="h-4 w-4 text-primary" aria-hidden /> Leave Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canFileForOthers && employeesError ? (
              <p className="text-xs text-muted-foreground">
                Employee list unavailable ({employeesError}) — the request will be filed for yourself.
              </p>
            ) : null}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {canFileForOthers ? (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Employee</Label>
                  <Select
                    value={form.employeeId || "SELF"}
                    onValueChange={(v) => setForm((f) => ({ ...f, employeeId: v === "SELF" ? "" : v }))}
                  >
                    <SelectTrigger aria-label="Employee"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SELF">Myself</SelectItem>
                      {employeeOptions.map((o) => (
                        <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                  <SelectTrigger aria-label="Leave type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LEAVE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="leave-start">Start Date</Label>
                <Input
                  id="leave-start" type="date" value={form.startDate}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, startDate: e.target.value }));
                    setErrors((p) => ({ ...p, endDate: undefined }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="leave-end">End Date</Label>
                <Input
                  id="leave-end" type="date" value={form.endDate}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, endDate: e.target.value }));
                    setErrors((p) => ({ ...p, endDate: undefined }));
                  }}
                  aria-invalid={!!errors.endDate}
                  aria-describedby={errors.endDate ? "leave-end-err" : undefined}
                />
                {errors.endDate ? (
                  <p id="leave-end-err" className="text-xs text-destructive">{errors.endDate}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Days are computed automatically (inclusive).</p>
                )}
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="leave-reason">Reason</Label>
                <Textarea
                  id="leave-reason" rows={3} value={form.reason}
                  onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                  placeholder="Brief reason for the request…"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </PageShell>

      {/* Sticky mobile action bar */}
      <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          {submitButton}
        </div>
      </div>
    </div>
  );
}
