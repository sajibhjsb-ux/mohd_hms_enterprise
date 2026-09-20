"use client";

// MOHD.HMS ENTERPRISE — Position management (HR module, spec §9/§24).
// Managed job titles — SEPARATE from application roles: a position describes
// WHAT a person's job is ("Finance Director"), a role describes what they may
// DO (ADMIN). This UI manages the catalog only; assigning titles happens in
// User Management (Job information) and the Employees module.
//
// Surfaces (following the departments/attendance dedicated-page pattern):
//   <PositionsTab />        → "Positions" tab content on the HR list page
//   <HrPositionNewPage />   → /hr/positions/new
//   <HrPositionEditPage />  → /hr/positions/{id}/edit
// Positions are DEACTIVATED — never hard-deleted — so historical employee
// records stay valid (spec §24).

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { StatusBadge, EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DepartmentField } from "../employees/department-field";
import { AlertCircle, Briefcase, Loader2, Pencil, Plus, Power } from "lucide-react";

type PositionRow = {
  id: string;
  name: string;
  description: string;
  status: string;
  departmentId: string | null;
  department: { id: string; name: string } | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  inUse: number;
};

type PositionForm = { name: string; description: string; departmentId: string };

const EMPTY_FORM: PositionForm = { name: "", description: "", departmentId: "" };

/** Shared departmentId validation for the create/update payload. */
function departmentPayload(f: PositionForm) {
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    departmentId: f.departmentId || null,
  };
}

function FieldProblem({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive mt-1">{msg}</p>;
}

/** Form card shared by the New and Edit pages (identical fields). */
function PositionFormFields({
  form, setForm, errors, idPrefix,
}: {
  form: PositionForm;
  setForm: (patch: Partial<PositionForm>) => void;
  errors: Record<string, string>;
  idPrefix: string;
}) {
  return (
    <CardContent className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-name`}>Position name *</Label>
        <Input
          id={`${idPrefix}-name`}
          value={form.name}
          onChange={(e) => setForm({ name: e.target.value })}
          placeholder="e.g. Finance Director"
          aria-invalid={!!errors.name}
        />
        <FieldProblem msg={errors.name} />
      </div>
      <DepartmentField
        value={form.departmentId}
        onChange={(v) => setForm({ departmentId: v === "none" ? "" : v })}
        idPrefix={idPrefix}
      />
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-desc`}>Description</Label>
        <Textarea
          id={`${idPrefix}-desc`}
          rows={2}
          value={form.description}
          onChange={(e) => setForm({ description: e.target.value })}
          placeholder="What this position is responsible for…"
        />
      </div>
      <p className="text-xs rounded-md bg-muted px-3 py-2 text-muted-foreground">
        A position is a job title only — it never grants application access. Access is controlled exclusively by the account ROLE.
      </p>
    </CardContent>
  );
}

// ── Tab: catalog list ──

export function PositionsTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.hr_manage);
  const openPage = useCallback((seg: string[]) => navigateTo("hr", seg), []);

  const [rows, setRows] = useState<PositionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toggleRow, setToggleRow] = useState<PositionRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<PositionRow[]>(`/api/v1/hr/positions${qs({ pageSize: 200, sort: "name" })}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
      setRows(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.hr, () => { void load(); });

  async function submitToggle() {
    if (!toggleRow) return;
    setSaving(true);
    const target = toggleRow.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    try {
      await api.patch(`/api/v1/hr/positions/${toggleRow.id}`, { status: target });
      toast({
        title: target === "INACTIVE" ? "Position deactivated" : "Position activated",
        description: `${toggleRow.name} is now ${target === "INACTIVE" ? "INACTIVE — history kept, no new assignments" : "ACTIVE — assignable again"}.`,
      });
      setToggleRow(null);
      void load();
    } catch (e) {
      toast({ title: "Could not update position", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<PositionRow>[] = [
    {
      key: "name", header: "Position", value: (r) => r.name,
      render: (r) => (
        <div className="min-w-[140px]">
          <div className="font-medium truncate">{r.name}</div>
          <div className="text-xs text-muted-foreground truncate">{r.description || "—"}</div>
        </div>
      ),
    },
    {
      key: "department", header: "Department", value: (r) => r.department?.name ?? "",
      render: (r) => r.department?.name ?? "—",
      hideOnMobile: true,
    },
    {
      key: "inUse", header: "People", value: (r) => r.inUse,
      render: (r) => <span className="tabular-nums">{r.inUse}</span>,
      hideOnMobile: true,
    },
    { key: "updatedAt", header: "Updated", value: (r) => r.updatedAt, render: (r) => fmtDate(r.updatedAt), hideOnMobile: true },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "actions", header: "", sortable: false,
      render: (r) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {canManage ? (
            <>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openPage(["positions", r.id, "edit"])} aria-label={`Edit ${r.name}`}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 ${r.status === "ACTIVE" ? "text-destructive hover:text-destructive" : "text-emerald-700 hover:text-emerald-700"}`}
                onClick={() => setToggleRow(r)}
                aria-label={r.status === "ACTIVE" ? `Deactivate ${r.name}` : `Activate ${r.name}`}
              >
                <Power className="h-4 w-4" />
              </Button>
            </>
          ) : null}
        </div>
      ),
      className: "w-4",
    },
  ];

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (rows === null) return <LoadingState label="Loading positions…" />;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm text-muted-foreground">
          Managed job titles — independent from application roles. Deactivated titles keep their history.
        </p>
        {canManage ? (
          <Button size="sm" onClick={() => openPage(["positions", "new"])}>
            <Plus className="h-4 w-4 mr-1.5" /> New Position
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => { if (canManage) openPage(["positions", r.id, "edit"]); }}
        searchPlaceholder="Search positions…"
        filters={[
          {
            key: "status", label: "Status",
            options: [{ value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }],
            match: (r, v) => r.status === v,
          },
          {
            key: "department", label: "Department",
            options: [...new Set(rows.map((r) => r.department?.name).filter((n): n is string => !!n))].sort().map((n) => ({ value: n, label: n })),
            match: (r, v) => r.department?.name === v,
          },
        ]}
        emptyTitle="No positions yet"
        emptyHint={canManage ? "Create the first managed job title." : "Positions will appear here once created."}
        exportName="positions"
      />

      <AlertDialog open={!!toggleRow} onOpenChange={(o) => !o && setToggleRow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {toggleRow?.status === "ACTIVE" ? "Deactivate" : "Activate"} “{toggleRow?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {toggleRow?.status === "ACTIVE"
                ? "The title stays on everyone who holds it and all history remains valid; it simply can no longer be assigned to new people."
                : "The title becomes assignable again in User Management and the Employees module."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={(e) => { e.preventDefault(); submitToggle(); }}>
              {saving ? "Working…" : toggleRow?.status === "ACTIVE" ? "Deactivate" : "Activate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── New page ──

export function HrPositionNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.hr_manage);

  const [form, setFormState] = useState<PositionForm>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(EMPTY_FORM));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setForm = (patch: Partial<PositionForm>) => setFormState((f) => ({ ...f, ...patch }));
  const dirty = useMemo(() => JSON.stringify(form) !== baseline, [form, baseline]);
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function save() {
    if (!form.name.trim() || form.name.trim().length < 2) {
      setErrors({ name: "Position name is required (min 2 characters)." });
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      await api.post("/api/v1/hr/positions", departmentPayload(form));
      toast({ title: "Position created", description: form.name.trim() });
      setPageDirty(false);
      navigateTo("hr");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not create the position. Please try again.";
      setSubmitError(msg);
      setErrors(extractPositionFieldErrors(e));
      toast({ title: "Could not create position", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageShell
        backLabel="Back to HR" backHref="/hr"
        crumbs={[{ label: "HR", href: "/hr" }, { label: "Positions" }, { label: "New Position" }]}
        title="New Position"
      >
        <EmptyState
          title="You don't have permission to create positions"
          hint="Position management requires the hr.manage permission. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const createButton = (
    <Button onClick={() => void save()} disabled={saving} className="flex-1 sm:flex-none">
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
      {saving ? "Creating…" : "Create Position"}
    </Button>
  );

  return (
    <div>
      <PageShell
        backLabel="Back to HR" backHref="/hr"
        crumbs={[{ label: "HR", href: "/hr" }, { label: "Positions" }, { label: "New Position" }]}
        title="New Position"
        description="Position names must be unique."
        actions={<div className="hidden sm:flex items-center gap-2 no-print">{createButton}</div>}
      >
        {submitError ? (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">The position could not be created.</p>
              <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
            </div>
          </div>
        ) : null}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Briefcase className="h-4 w-4" aria-hidden /> Position Details</CardTitle>
          </CardHeader>
          <PositionFormFields form={form} setForm={setForm} errors={errors} idPrefix="pos-new" />
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

// ── Edit page ──

export function HrPositionEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.hr_manage);

  const [row, setRow] = useState<PositionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setFormState] = useState<PositionForm>(EMPTY_FORM);
  const [initial, setInitial] = useState<string>(() => JSON.stringify(EMPTY_FORM));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const setForm = (patch: Partial<PositionForm>) => setFormState((f) => ({ ...f, ...patch }));
  const dirty = useMemo(() => JSON.stringify(form) !== initial, [form, initial]);
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<PositionRow>(`/api/v1/hr/positions/${id}`);
      setRow(res.data);
      const f: PositionForm = {
        name: res.data.name,
        description: res.data.description ?? "",
        departmentId: res.data.departmentId ?? "",
      };
      setFormState(f);
      setInitial(JSON.stringify(f));
    } catch (e) {
      setLoadError(e instanceof ClientApiError ? e.message : "Could not load this position.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!row) return;
    if (!form.name.trim() || form.name.trim().length < 2) {
      setErrors({ name: "Position name is required (min 2 characters)." });
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      await api.patch(`/api/v1/hr/positions/${row.id}`, departmentPayload(form));
      toast({ title: "Position updated", description: form.name.trim() });
      setPageDirty(false);
      navigateTo("hr");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not update the position. Please try again.";
      setErrors(extractPositionFieldErrors(e));
      toast({ title: "Could not update position", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageShell
        backLabel="Back to HR" backHref="/hr"
        crumbs={[{ label: "HR", href: "/hr" }, { label: "Positions" }, { label: "Edit" }]}
        title="Edit Position"
      >
        <EmptyState
          title="You don't have permission to edit positions"
          hint="Position management requires the hr.manage permission."
        />
      </PageShell>
    );
  }

  if (loading && !row) {
    return <PageShell backLabel="Back to HR" backHref="/hr" title="Edit Position"><LoadingState label="Loading position…" rows={3} /></PageShell>;
  }
  if (loadError && !row) {
    return <PageShell backLabel="Back to HR" backHref="/hr" title="Edit Position"><ErrorState message={loadError} onRetry={load} /></PageShell>;
  }
  if (!row) {
    return <PageShell backLabel="Back to HR" backHref="/hr" title="Edit Position"><EmptyState title="Position not found" hint="The link may be incorrect." /></PageShell>;
  }

  const saveButton = (
    <Button onClick={() => void save()} disabled={saving || !dirty} className="flex-1 sm:flex-none">
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
      {saving ? "Saving…" : "Save changes"}
    </Button>
  );

  return (
    <div>
      <PageShell
        backLabel="Back to HR" backHref="/hr"
        crumbs={[{ label: "HR", href: "/hr" }, { label: "Positions" }, { label: row.name, href: "/hr" }, { label: "Edit" }]}
        title={`Edit ${row.name}`}
        description={`${row.inUse} ${row.inUse === 1 ? "person holds" : "people hold"} this position · status ${row.status}.`}
        actions={<div className="hidden sm:flex items-center gap-2 no-print">{saveButton}</div>}
      >
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Briefcase className="h-4 w-4" aria-hidden /> Position Details</CardTitle>
          </CardHeader>
          <PositionFormFields form={form} setForm={setForm} errors={errors} idPrefix="pos-edit" />
        </Card>
      </PageShell>

      <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          {saveButton}
        </div>
      </div>
    </div>
  );
}

/** Map server field errors (zod details) onto the form fields. */
function extractPositionFieldErrors(e: unknown): Record<string, string> {
  if (e instanceof ClientApiError && Array.isArray(e.details)) {
    const out: Record<string, string> = {};
    for (const d of e.details as { path?: string; message?: string }[]) {
      if (d?.path && d?.message) out[d.path] = d.message;
    }
    return out;
  }
  return {};
}
