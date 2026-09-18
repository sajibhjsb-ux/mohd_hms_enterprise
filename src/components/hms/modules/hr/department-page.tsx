"use client";

// MOHD.HMS ENTERPRISE — dedicated New Department page (hr/departments view).
// Replaces the former department dialog. Routing: #/hr/departments/new.
// POST /api/v1/hr/departments (names must be unique — server enforces) — no new APIs.

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Loader2, Plus } from "lucide-react";

type DeptForm = { name: string; description: string };

const emptyForm = (): DeptForm => ({ name: "", description: "" });

export function HrDepartmentNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.hr_manage);

  const [form, setForm] = useState<DeptForm>(emptyForm);
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(emptyForm()));
  const [errors, setErrors] = useState<{ name?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => JSON.stringify(form) !== baseline, [form, baseline]);
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function save() {
    if (!form.name.trim()) {
      setErrors({ name: "Department name is required." });
      toast({ title: "Department name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      await api.post("/api/v1/hr/departments", { name: form.name.trim(), description: form.description.trim() });
      toast({ title: "Department created", description: form.name.trim() });
      setPageDirty(false);
      navigateTo("hr");
    } catch (e) {
      // Keep every entered value — the error banner allows an immediate retry.
      const msg = e instanceof Error ? e.message : "Could not create the department. Please try again.";
      setSubmitError(msg);
      toast({ title: "Could not create department", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageShell
        backLabel="Back to HR" backHref="#/hr"
        crumbs={[{ label: "HR", href: "#/hr" }, { label: "Departments" }, { label: "New Department" }]}
        title="New Department"
      >
        <EmptyState
          title="You don't have permission to create departments"
          hint="Department creation requires the hr.manage permission. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const createButton = (
    <Button onClick={() => void save()} disabled={saving} className="flex-1 sm:flex-none">
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
      {saving ? "Creating…" : "Create Department"}
    </Button>
  );

  return (
    <div>
      <PageShell
        backLabel="Back to HR" backHref="#/hr"
        crumbs={[{ label: "HR", href: "#/hr" }, { label: "Departments" }, { label: "New Department" }]}
        title="New Department"
        description="Department names must be unique."
        actions={<div className="hidden sm:flex items-center gap-2 no-print">{createButton}</div>}
      >
        {submitError ? (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">The department could not be created.</p>
              <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
            </div>
          </div>
        ) : null}

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Department Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="dept-name">Name *</Label>
              <Input
                id="dept-name"
                value={form.name}
                onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setErrors((p) => ({ ...p, name: undefined })); }}
                placeholder="Field Operations"
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? "dept-name-err" : undefined}
              />
              {errors.name ? <p id="dept-name-err" className="text-xs text-destructive">{errors.name}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dept-desc">Description</Label>
              <Textarea
                id="dept-desc" rows={2} value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What this team does…"
              />
            </div>
          </CardContent>
        </Card>
      </PageShell>

      {/* Sticky mobile action bar */}
      <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          {createButton}
        </div>
      </div>
    </div>
  );
}
