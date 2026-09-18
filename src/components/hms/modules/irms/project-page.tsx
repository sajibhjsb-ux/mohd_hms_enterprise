"use client";

// MOHD.HMS ENTERPRISE — dedicated IRMS project pages (create + edit).
// Routing (hash router):
//   #/irms/projects/new         → create  (pageFromSeg: prefix view "projects", id "new")
//   #/irms/{id}/edit            → edit    (2-seg suffix → view "edit")
//   #/irms/projects/{id}/edit   → edit    (3-seg form → view "projects-edit")
//
// ONE shared field set + payload builder (no duplicate form logic):
//   • create keeps the existing draft architecture (useDraft
//     "irms.project.create") with the restore banner — as the old dialog had.
//   • edit loads the project (GET /api/v1/irms/projects/{id}) and PATCHes it,
//     including the status select (edit-only, as before).
// No new APIs — POST/PATCH /api/v1/irms/projects(/{id}) exactly as the dialogs did.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { fmtDateTime, toDateInput } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Loader2, Plus, Save } from "lucide-react";

// ── Shared types / constants ──

const PROJECT_STATUSES = ["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED"];

const emptyProjectForm = {
  name: "",
  customerId: "",
  siteLocation: "",
  description: "",
  startDate: "",
  endDate: "",
};
type ProjectFormValues = typeof emptyProjectForm;

type CustomerOpt = { id: string; companyName: string };

type ProjectApiResponse = {
  id: string;
  code: string;
  name: string;
  siteLocation: string;
  description: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  customer?: { id: string; companyName: string } | null;
};

/** Shared field renderer — single source of the form layout (create + edit). */
function ProjectFields({
  values, set, customers, showStatus = false, status, onStatusChange, errors,
}: {
  values: ProjectFormValues;
  set: (patch: Partial<ProjectFormValues>) => void;
  customers: CustomerOpt[] | null;
  showStatus?: boolean;
  status?: string;
  onStatusChange?: (s: string) => void;
  errors: { name?: string };
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="prj-name">Project Name *</Label>
        <Input
          id="prj-name"
          value={values.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Sunrise Mall Annual Facility Audit"
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? "prj-name-err" : undefined}
        />
        {errors.name ? <p id="prj-name-err" className="text-xs text-destructive">{errors.name}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label>Customer</Label>
        <Select
          value={values.customerId || "NONE"}
          onValueChange={(v) => set({ customerId: v === "NONE" ? "" : v })}
          disabled={customers === null}
        >
          <SelectTrigger aria-label="Customer"><SelectValue placeholder={customers === null ? "Unavailable" : "Internal"} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="NONE">Internal / No customer</SelectItem>
            {(customers ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.companyName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="prj-site">Site Location</Label>
        <Input
          id="prj-site"
          value={values.siteLocation}
          onChange={(e) => set({ siteLocation: e.target.value })}
          placeholder="Bukit Bintang, Kuala Lumpur"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="prj-start">Start Date</Label>
        <Input id="prj-start" type="date" value={values.startDate} onChange={(e) => set({ startDate: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="prj-end">End Date</Label>
        <Input id="prj-end" type="date" value={values.endDate} onChange={(e) => set({ endDate: e.target.value })} />
      </div>
      {showStatus ? (
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select value={status} onValueChange={(v) => onStatusChange?.(v)}>
            <SelectTrigger aria-label="Project status"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROJECT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="prj-desc">Description</Label>
        <Textarea
          id="prj-desc" rows={3}
          value={values.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Scope of the inspection programme…"
        />
      </div>
    </div>
  );
}

/** Same payload shape the old dialog built (saveProject create/edit branches). */
function buildPayload(values: ProjectFormValues, status?: string) {
  return {
    name: values.name.trim(),
    customerId: values.customerId || null,
    siteLocation: values.siteLocation.trim(),
    description: values.description.trim(),
    startDate: values.startDate || null,
    endDate: values.endDate || null,
    ...(status ? { status } : {}),
  };
}

/** Customer options; degrade to null (select disabled "Unavailable") on 403/failure. */
function useCustomerOptions(): CustomerOpt[] | null {
  const [options, setOptions] = useState<CustomerOpt[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<CustomerOpt[]>(`/api/v1/customers${qs({ pageSize: 200 })}`)
      .then((r) => { if (alive) setOptions(r.data ?? []); })
      .catch(() => { if (alive) setOptions(null); });
    return () => { alive = false; };
  }, []);
  return options;
}

/** Page chrome shared by create + edit (PageShell + sticky mobile action bar). */
function ProjectPageScaffold({ title, description, primary, children }: {
  title: string;
  description: string;
  primary: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <PageShell
        backLabel="Back to IRMS" backHref="#/irms"
        crumbs={[{ label: "IRMS", href: "#/irms" }, { label: "Projects" }, { label: title }]}
        title={title}
        description={description}
        actions={<div className="hidden sm:flex items-center gap-2 no-print">{primary}</div>}
      >
        {children}
      </PageShell>
      {/* Sticky mobile action bar */}
      <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          {primary}
        </div>
      </div>
    </div>
  );
}

function SubmitErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">The project could not be saved.</p>
        <p className="mt-0.5">{message} Your entries are preserved — you can retry.</p>
      </div>
    </div>
  );
}

// ── Create page ──

export function IrmsProjectNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.irms_manage);

  const projectDraft = useDraft<ProjectFormValues>({ formKey: "irms.project.create", initial: emptyProjectForm });
  const customers = useCustomerOptions();
  const [errors, setErrors] = useState<{ name?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Dirty-state wiring (central router guard + data protection).
  useEffect(() => {
    setPageDirty(projectDraft.dirty);
    return () => { setPageDirty(false); };
  }, [projectDraft.dirty, setPageDirty]);

  async function save() {
    if (!projectDraft.value.name.trim()) {
      setErrors({ name: "Project name is required." });
      toast({ title: "Project name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      const res = await api.post<{ id: string; code: string; name: string }>("/api/v1/irms/projects", buildPayload(projectDraft.value));
      toast({ title: "Project created", description: `${res.data.code} — ${res.data.name}.` });
      projectDraft.reset(emptyProjectForm);
      setPageDirty(false);
      navigateTo("irms");
    } catch (e) {
      // Keep every user-entered value on failure — show the error and allow retry.
      const msg = e instanceof Error ? e.message : "Could not create the project. Please try again.";
      setSubmitError(msg);
      toast({ title: "Could not create project", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="#/irms" title="New Inspection Project">
        <EmptyState
          title="You don't have permission to manage inspection projects"
          hint="Creating projects requires the irms.manage permission. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const primary = (
    <Button onClick={() => void save()} disabled={saving} className="flex-1 sm:flex-none">
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
      {saving ? "Saving…" : "Create Project"}
    </Button>
  );

  return (
    <ProjectPageScaffold
      title="New Inspection Project"
      description="Group inspection reports under a site project. Draft is auto-saved."
      primary={primary}
    >
      {/* Recoverable draft banner (same draft as the old dialog) */}
      {projectDraft.draftExists ? (
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-sm no-print">
          <span className="text-muted-foreground">
            Unsubmitted project draft saved{projectDraft.lastSavedAt ? ` ${fmtDateTime(projectDraft.lastSavedAt)}` : " earlier"} — restore it to continue where you left off.
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={projectDraft.restore}>Restore</Button>
            <Button size="sm" variant="ghost" onClick={projectDraft.discard}>Discard</Button>
          </div>
        </div>
      ) : null}

      {submitError ? <SubmitErrorBanner message={submitError} /> : null}

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Project Details</CardTitle>
        </CardHeader>
        <CardContent>
          <ProjectFields
            values={projectDraft.value}
            set={projectDraft.setValue}
            customers={customers}
            errors={errors}
          />
        </CardContent>
      </Card>

      {/* Autosave hint (kept from the old dialog footer) */}
      <p className="mt-3 text-xs text-muted-foreground no-print">
        {projectDraft.dirty
          ? "Draft auto-saves as you type — safe to leave and restore later."
          : projectDraft.lastSavedAt
            ? `Draft saved at ${fmtDateTime(projectDraft.lastSavedAt)}.`
            : "Tip: the form auto-saves as a draft while you type."}
      </p>
    </ProjectPageScaffold>
  );
}

// ── Edit page ──

export function IrmsProjectEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.irms_manage);

  const [detail, setDetail] = useState<ProjectApiResponse | null>(null);
  const [form, setForm] = useState<ProjectFormValues | null>(null);
  const [status, setStatus] = useState("ACTIVE");
  const [baseline, setBaseline] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<{ name?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const customers = useCustomerOptions();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<ProjectApiResponse>(`/api/v1/irms/projects/${id}`);
      const p = res.data;
      const values: ProjectFormValues = {
        name: p.name,
        customerId: p.customer?.id ?? "",
        siteLocation: p.siteLocation ?? "",
        description: p.description ?? "",
        startDate: toDateInput(p.startDate),
        endDate: toDateInput(p.endDate),
      };
      setDetail(p);
      setForm(values);
      setStatus(p.status);
      setBaseline(JSON.stringify(values));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this project.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(
    () => !!form && baseline !== null && JSON.stringify(form) !== baseline,
    [form, baseline]
  );
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function save() {
    if (!form) return;
    if (!form.name.trim()) {
      setErrors({ name: "Project name is required." });
      toast({ title: "Project name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      await api.patch(`/api/v1/irms/projects/${id}`, buildPayload(form, status));
      toast({ title: "Project updated", description: `${detail?.code ?? "Project"} saved.` });
      setPageDirty(false);
      // Projects have no detail page — return to the list (existing UX).
      navigateTo("irms");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not update the project. Please try again.";
      setSubmitError(msg);
      toast({ title: "Update failed", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="#/irms" title="Edit Project">
        <EmptyState
          title="You don't have permission to manage inspection projects"
          hint="Editing projects requires the irms.manage permission. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  if (loading && !form) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="#/irms" title="Edit Project">
        <LoadingState label="Loading project…" rows={3} />
      </PageShell>
    );
  }
  if (loadError && !form) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="#/irms" title="Edit Project">
        <ErrorState message={loadError} onRetry={() => void load()} />
      </PageShell>
    );
  }
  if (!form || !detail) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="#/irms" title="Edit Project">
        <EmptyState title="Project not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const primary = (
    <Button onClick={() => void save()} disabled={saving} className="flex-1 sm:flex-none">
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
      {saving ? "Saving…" : "Save Changes"}
    </Button>
  );

  return (
    <ProjectPageScaffold
      title={`Edit ${detail.code}`}
      description="Update project details or status."
      primary={primary}
    >
      {submitError ? <SubmitErrorBanner message={submitError} /> : null}

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Project Details</CardTitle>
        </CardHeader>
        <CardContent>
          <ProjectFields
            values={form}
            set={(patch) => { setForm((f) => (f ? { ...f, ...patch } : f)); setErrors((p) => ({ ...p, name: undefined })); }}
            customers={customers}
            showStatus
            status={status}
            onStatusChange={setStatus}
            errors={errors}
          />
        </CardContent>
      </Card>
    </ProjectPageScaffold>
  );
}
