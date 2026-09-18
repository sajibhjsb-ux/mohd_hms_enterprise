"use client";

// MOHD.HMS ENTERPRISE — dedicated Edit Complaint page (complaints/{id}/edit view).
// Same API as the workflow (GET + PATCH /api/v1/complaints/{id}) — no popup.
// The server only allows editing while the complaint status is NEW, so the page
// shows a clear notice state for anything past NEW. Editable fields: title,
// description, priority and the equipment link; the customer is fixed.
//
// DATA PROTECTION: every typed value is preserved on API/validation failure —
// the form never resets. Unsaved changes are guarded by the central router
// guard (pageDirty) and a browser-level beforeunload warning.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, humanize, PRIORITIES } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Save } from "lucide-react";

// ── Types ──

const TITLE_MAX = 120;
const DESC_MAX = 2000;

type ComplaintEditable = {
  id: string;
  code: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  customerId: string;
  equipmentId: string | null;
  customer?: { id: string; companyName: string } | null;
  equipment?: { id: string; name: string; assetTag: string } | null;
};

type EquipmentOption = { id: string; name: string; assetTag: string };

type FormState = {
  title: string;
  description: string;
  priority: string;
  equipmentId: string; // "" = not linked to equipment
};

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

function toForm(c: ComplaintEditable): FormState {
  return {
    title: c.title,
    description: c.description,
    priority: c.priority,
    equipmentId: c.equipmentId ?? "",
  };
}

function formEquals(a: FormState, b: FormState): boolean {
  return a.title === b.title && a.description === b.description
    && a.priority === b.priority && a.equipmentId === b.equipmentId;
}

// ── Page ──

export function ComplaintEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canUpdate = hasPerm(user, PERMISSIONS.complaints_update);

  const [complaint, setComplaint] = useState<ComplaintEditable | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<ComplaintEditable>(`/api/v1/complaints/${id}`);
      setComplaint(res.data);
      const f = toForm(res.data);
      setForm(f);
      setInitial(f);
      if (res.data.customerId) {
        try {
          const eq = await api.get<EquipmentOption[]>(
            `/api/v1/equipment${`?customerId=${encodeURIComponent(res.data.customerId)}&pageSize=200`}`
          );
          setEquipment(eq.data);
        } catch {
          setEquipment([]); // equipment options are optional — the form still works
        }
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this complaint.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // ── Dirty-state wiring (central router guard protects typed edits) ──
  const dirty = useMemo(
    () => !!form && !!initial && !formEquals(form, initial),
    [form, initial]
  );
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function submitEdit() {
    if (!complaint || !form) return;
    const errs: FieldErrors = {};
    if (!form.title.trim()) errs.title = "Title is required.";
    if (!form.description.trim()) errs.description = "Description is required.";
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    setSubmitError(null);
    try {
      await api.patch(`/api/v1/complaints/${complaint.id}`, {
        title: form.title.trim(),
        description: form.description.trim(),
        priority: form.priority,
        equipmentId: form.equipmentId || null,
      });
      toast({ title: "Complaint updated", description: `${complaint.code} saved.` });
      setPageDirty(false);
      navigateTo("complaints", [complaint.id]);
    } catch (e) {
      // Keep every edited value on failure — show the error and allow retry.
      setFieldErrors(extractFieldErrors(e));
      setSubmitError(e instanceof Error ? e.message : "The complaint could not be saved.");
      toast({ title: "Could not update complaint", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── RBAC gate (server enforces the same rules again) ──
  const isPortalOwner = !!user && user.role === "CUSTOMER" && !!complaint && user.customerId === complaint.customerId;
  if (!canUpdate && !isPortalOwner) {
    return (
      <PageShell
        backLabel="Back to Complaints"
        backHref="/complaints"
        crumbs={[{ label: "Complaints", href: "/complaints" }, { label: "Edit" }]}
        title="Edit complaint"
      >
        <EmptyState title="You cannot edit this complaint" hint="Editing requires the complaints update permission." />
      </PageShell>
    );
  }

  if (loading && !complaint) {
    return (
      <PageShell
        backLabel="Back to Complaints"
        backHref="/complaints"
        crumbs={[{ label: "Complaints", href: "/complaints" }, { label: "Edit" }]}
        title="Edit complaint"
      >
        <LoadingState label="Loading complaint…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !complaint) {
    return (
      <PageShell
        backLabel="Back to Complaints"
        backHref="/complaints"
        crumbs={[{ label: "Complaints", href: "/complaints" }, { label: "Edit" }]}
        title="Edit complaint"
      >
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!complaint || !form) {
    return (
      <PageShell
        backLabel="Back to Complaints"
        backHref="/complaints"
        crumbs={[{ label: "Complaints", href: "/complaints" }, { label: "Edit" }]}
        title="Edit complaint"
      >
        <EmptyState title="Complaint not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  // Workflow gate — the API rejects edits after NEW; explain instead of failing.
  if (complaint.status !== "NEW") {
    return (
      <PageShell
        backLabel="Back to complaint"
        backHref={`/complaints/${encodeURIComponent(complaint.id)}`}
        crumbs={[
          { label: "Complaints", href: "/complaints" },
          { label: complaint.code, href: `/complaints/${encodeURIComponent(complaint.id)}` },
          { label: "Edit" },
        ]}
        title="Edit complaint"
      >
        <EmptyState
          title="This complaint can no longer be edited"
          hint={`Editing is only possible while the complaint is NEW — ${complaint.code} is now ${humanize(complaint.status)}. Use the workflow actions on the detail page instead.`}
        />
      </PageShell>
    );
  }

  const backToDetail = () => navigateTo("complaints", [complaint.id]);

  return (
    <PageShell
      backLabel="Back to complaint"
      backHref={`/complaints/${encodeURIComponent(complaint.id)}`}
      crumbs={[
        { label: "Complaints", href: "/complaints" },
        { label: complaint.code, href: `/complaints/${encodeURIComponent(complaint.id)}` },
        { label: "Edit" },
      ]}
      title={`Edit ${complaint.code}`}
      description={`Reported by ${complaint.customer?.companyName ?? "the customer"} — editable while the complaint is NEW.`}
      actions={
        <div className="flex items-center gap-2 no-print">
          <Button variant="outline" onClick={backToDetail}>Cancel</Button>
          <Button onClick={submitEdit} disabled={saving || !dirty}>
            {saving ? (
              <span className="h-4 w-4 mr-1.5 inline-block rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4 mr-1.5" />
            )}
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      }
    >
      {submitError ? (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <div>
            <p className="font-medium">The complaint could not be saved.</p>
            <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-4 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Complaint Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ec-title">Title *</Label>
              <Input
                id="ec-title"
                value={form.title}
                onChange={(e) => { setForm({ ...form, title: e.target.value }); setFieldErrors((p) => ({ ...p, title: "" })); }}
                maxLength={TITLE_MAX}
                aria-invalid={!!fieldErrors.title}
                aria-describedby={fieldErrors.title ? "ec-title-err" : undefined}
              />
              <FieldError msg={fieldErrors.title} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ec-desc">Description *</Label>
              <Textarea
                id="ec-desc"
                value={form.description}
                onChange={(e) => { setForm({ ...form, description: e.target.value }); setFieldErrors((p) => ({ ...p, description: "" })); }}
                rows={7}
                maxLength={DESC_MAX}
                aria-invalid={!!fieldErrors.description}
                aria-describedby={fieldErrors.description ? "ec-desc-err" : undefined}
                className="min-h-[9rem]"
              />
              <FieldError msg={fieldErrors.description} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v })}>
                  <SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Equipment</Label>
                <Select value={form.equipmentId || "none"} onValueChange={(v) => setForm({ ...form, equipmentId: v === "none" ? "" : v })}>
                  <SelectTrigger aria-label="Linked equipment"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not linked to equipment</SelectItem>
                    {equipment.map((eq) => (
                      <SelectItem key={eq.id} value={eq.id}>{eq.name} ({eq.assetTag})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">Only units belonging to this customer are listed.</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Customer</Label>
              <Input value={complaint.customer?.companyName ?? "—"} disabled aria-readonly />
              <p className="text-[11px] text-muted-foreground">The customer cannot be changed after a complaint is logged.</p>
            </div>
          </CardContent>
        </Card>

        {/* Side summary */}
        <Card className="xl:col-span-1 shadow-sm h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Editing rules</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2">
            <p>· Complaints are editable only while status is NEW.</p>
            <p>· After assignment, changes happen through the workflow actions on the detail page.</p>
            <p>· Unsaved changes are protected — navigation asks before leaving this page.</p>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
