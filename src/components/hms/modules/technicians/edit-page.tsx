"use client";

// MOHD.HMS ENTERPRISE — dedicated Edit Technician page (technicians "edit"
// view, also served for the "detail" view which has no page of its own).
// Replaces the old rate/skills editor dialog. Same API (PATCH
// /api/v1/technicians/{id} { skills, specialty, hourlyRate }) and the same
// manual rate validation (NaN / negative → toast, no request).
//
// PREFILL APPROACH (documented): per module spec, prefill uses the LIST
// endpoint — GET /api/v1/technicians?pageSize=200 — and finds the profile by
// id, because this module's UI is typed against the list contract (workload
// counters etc.). The roster is small and capped by pageSize, so this is safe.

import { useCallback, useEffect, useState } from "react";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { fromCents, toCents } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Exact list contract produced by /api/v1/technicians (GET). */
export type TechRow = {
  id: string;
  employeeNo: string;
  skills: string;
  specialty: string;
  hourlyRateCents: number;
  status: string; // AVAILABLE | ON_JOB | OFF_DUTY
  user: { id: string; name: string; email: string; phone: string | null; status: string };
  openWorkOrders: number;
  completedWorkOrders: number;
  openComplaints: number;
  openPmTasks: number;
};

/** Comma-separated skills string → up to 8 trimmed chips (list + editor share it). */
export function parseSkills(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
}

type TechForm = { skills: string; specialty: string; rate: string };

export function TechnicianEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canUpdate = hasPerm(user, PERMISSIONS.users_update);

  const [tech, setTech] = useState<TechRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<TechForm | null>(null);
  const [initial, setInitial] = useState<TechForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // List-based prefill (see header note): load the roster, find by id.
      const res = await api.get<TechRow[]>(`/api/v1/technicians${qs({ pageSize: 200 })}`);
      const found = res.data.find((t) => t.id === id) ?? null;
      setTech(found);
      if (found) {
        const f: TechForm = { skills: found.skills, specialty: found.specialty, rate: fromCents(found.hourlyRateCents) };
        setForm(f);
        setInitial(f);
      } else {
        setForm(null);
        setInitial(null);
      }
    } catch (e) {
      setTech(null);
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
    if (!tech || !form) return;
    // Manual rate validation — kept exactly from the dialog editor.
    const rateNum = parseFloat(form.rate);
    if (form.rate !== "" && (isNaN(rateNum) || rateNum < 0)) {
      toast({ title: "Invalid hourly rate", description: "Enter a number, e.g. 55.25", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/api/v1/technicians/${tech.id}`, {
        skills: form.skills,
        specialty: form.specialty || undefined,
        hourlyRate: form.rate === "" ? 0 : toCents(form.rate) / 100, // decimal ringgit
      });
      toast({ title: "Technician updated", description: `${tech.user.name} saved.` });
      setPageDirty(false);
      navigateTo("technicians");
    } catch (e) {
      // Form values are preserved on failure — the user can retry.
      toast({ title: "Could not update technician", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canUpdate) {
    return (
      <PageShell
        backLabel="Back to Technicians"
        backHref="#/technicians"
        crumbs={[{ label: "Technicians", href: "#/technicians" }, { label: "Edit Skills & Rate" }]}
        title="Edit Skills & Rate"
      >
        <EmptyState
          title="You don't have permission to edit technicians"
          hint="Technician updates are limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const displayName = tech?.user.name ?? "Technician";

  if (loading && !tech) {
    return (
      <PageShell backLabel="Back to Technicians" backHref="#/technicians" title="Edit Skills & Rate">
        <LoadingState label="Loading technician…" rows={3} />
      </PageShell>
    );
  }

  if (loadError && !tech) {
    return (
      <PageShell backLabel="Back to Technicians" backHref="#/technicians" title="Edit Skills & Rate">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!tech || !form) {
    return (
      <PageShell backLabel="Back to Technicians" backHref="#/technicians" title="Edit Skills & Rate">
        <EmptyState title="Technician profile not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const set = (patch: Partial<TechForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const actions = (
    <>
      <Button variant="outline" onClick={() => navigateTo("technicians")} disabled={saving}>Cancel</Button>
      <Button onClick={submitEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
    </>
  );

  return (
    <PageShell
      backLabel="Back to Technicians"
      backHref="#/technicians"
      crumbs={[
        { label: "Technicians", href: "#/technicians" },
        { label: displayName },
        { label: "Edit Skills & Rate" },
      ]}
      title={`Edit ${displayName}`}
      description={`${tech.employeeNo} · skills, specialty and billing rate.`}
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{actions}</div>}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); submitEdit(); }}
        className="max-w-2xl"
      >
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">{displayName}</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">{tech.employeeNo}</p>
              </div>
              <StatusBadge status={tech.status} />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="t-skills">Skills (comma separated)</Label>
              <Input
                id="t-skills"
                value={form.skills}
                onChange={(e) => set({ skills: e.target.value })}
                placeholder="e.g. HVAC, ELECTRICAL, PLUMBING"
              />
              {form.skills ? (
                <div className="flex flex-wrap gap-1 mt-2">
                  {parseSkills(form.skills).map((s) => (
                    <Badge key={s} variant="secondary" className="text-[11px] font-normal">{s}</Badge>
                  ))}
                </div>
              ) : null}
            </div>
            <div>
              <Label htmlFor="t-specialty">Specialty</Label>
              <Input
                id="t-specialty"
                value={form.specialty}
                onChange={(e) => set({ specialty: e.target.value })}
                placeholder="e.g. ELECTRICAL"
              />
            </div>
            <div>
              <Label htmlFor="t-rate">Hourly rate (MYR)</Label>
              <Input
                id="t-rate"
                inputMode="decimal"
                value={form.rate}
                onChange={(e) => set({ rate: e.target.value })}
                placeholder="e.g. 55.25"
              />
              {form.rate !== "" && !isNaN(parseFloat(form.rate)) ? (
                <p className="text-xs text-muted-foreground mt-1">Stored as {toCents(form.rate).toLocaleString()} cents/hour</p>
              ) : null}
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
