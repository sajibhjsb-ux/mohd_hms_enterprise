"use client";

// MOHD.HMS ENTERPRISE — dedicated Edit Technician page (technicians "edit"
// view, also served for the "detail" view which has no page of its own).
//
// SKILLS (spec §6/§7/§8): the old free-text "Skills (comma separated)" input is
// replaced by the structured Skills Manager (skills-manager.tsx). Structured
// entries are canonical; the legacy CSV mirror is maintained by the API after
// every skill mutation, so this page no longer sends `skills` in the profile
// PATCH (that would overwrite the mirror with stale text).
//
// RBAC (the lockout fix): the page is usable by
//   • users.update holders (admins) — full edit (skills + specialty + rate);
//   • technicians.manage holders (supervisors) — skills manager only, with an
//     honest note that specialty/rate are managed by administrators;
//   • the technician themself (self path) — their own skills via the
//     self-service endpoint, fetched without users.read.
// Everyone else keeps the "no permission" state.
//
// PREFILL APPROACH (documented): per module spec, prefill uses the LIST
// endpoint — GET /api/v1/technicians?pageSize=200 — and finds the profile by
// id, because this module's UI is typed against the list contract (workload
// counters etc.). The roster is small and capped by pageSize, so this is safe.
// Callers WITHOUT users.read fall back to the self-service endpoint
// (GET /api/v1/profile/technician-skills) and can only open their own page.

import { useCallback, useEffect, useState } from "react";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { fromCents, toCents } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkillsManager, type SkillChip, type SkillEntry } from "./skills-manager";

/** Exact list contract produced by /api/v1/technicians (GET). */
export type TechRow = {
  id: string;
  employeeNo: string;
  skills: string;
  specialty: string;
  hourlyRateCents: number;
  status: string; // AVAILABLE | ON_JOB | OFF_DUTY
  skillEntries?: SkillChip[]; // structured entries (new include) — optional for stale payloads
  user: { id: string; name: string; email: string; phone: string | null; status: string };
  openWorkOrders: number;
  completedWorkOrders: number;
  openComplaints: number;
  openPmTasks: number;
};

/** Comma-separated skills string → up to 8 trimmed chips (legacy fallback display). */
export function parseSkills(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
}

/** Payload of GET /api/v1/technicians/{id}/skills. */
type SkillsPayload = { profile: { id: string; employeeNo: string; user: { id: string; name: string } }; skills: SkillEntry[] };
/** Payload of GET /api/v1/profile/technician-skills (self-service). */
type SelfSkillsPayload = {
  profile: { id: string; employeeNo: string; skills: string; specialty: string; status: string; hourlyRateCents: number };
  skills: SkillEntry[];
};

type TechForm = { specialty: string; rate: string };

export function TechnicianEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);

  const canReadRoster = hasPerm(user, PERMISSIONS.users_read);
  const canUpdate = hasPerm(user, PERMISSIONS.users_update);
  const canManageAny = hasPerm(user, PERMISSIONS.technicians_manage);

  const [tech, setTech] = useState<TechRow | null>(null);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [canEditSkills, setCanEditSkills] = useState(false);
  const [canSaveProfile, setCanSaveProfile] = useState(false);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<TechForm | null>(null);
  const [initial, setInitial] = useState<TechForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!user) return; // session still hydrating
    setLoading(true);
    setLoadError(null);
    setDenied(false);
    setTech(null);
    setForm(null);
    setInitial(null);
    setSkills([]);
    try {
      if (canReadRoster) {
        // List-based prefill (see header note): load the roster, find by id.
        const res = await api.get<TechRow[]>(`/api/v1/technicians${qs({ pageSize: 200 })}`);
        const found = res.data.find((t) => t.id === id) ?? null;
        if (!found) return;
        setTech(found);
        setCanEditSkills(canUpdate || canManageAny || found.user.id === user.id);
        setCanSaveProfile(canUpdate);
        if (canUpdate) {
          const f: TechForm = { specialty: found.specialty, rate: fromCents(found.hourlyRateCents) };
          setForm(f);
          setInitial(f);
        }
        // Full skill rows (certification / years) from the dedicated endpoint.
        try {
          const sk = await api.get<SkillsPayload>(`/api/v1/technicians/${id}/skills`);
          setSkills(sk.data.skills);
        } catch {
          // Degrade honestly to the roster projection (chips without cert/years).
          setSkills((found.skillEntries ?? []).map((c) => ({ ...c, certification: "", yearsExperience: null })));
        }
      } else {
        // Self path: technicians manage their OWN skills without users.read.
        const res = await api.get<SelfSkillsPayload>("/api/v1/profile/technician-skills");
        if (res.data.profile.id !== id) return; // someone else's page → not found
        setTech({
          id: res.data.profile.id,
          employeeNo: res.data.profile.employeeNo,
          skills: res.data.profile.skills,
          specialty: res.data.profile.specialty,
          hourlyRateCents: res.data.profile.hourlyRateCents,
          status: res.data.profile.status,
          skillEntries: res.data.skills.map((s) => ({ id: s.id, name: s.name, category: s.category, level: s.level })),
          user: { id: user.id, name: user.name, email: user.email, phone: null, status: "ACTIVE" },
          openWorkOrders: 0,
          completedWorkOrders: 0,
          openComplaints: 0,
          openPmTasks: 0,
        });
        setSkills(res.data.skills);
        setCanEditSkills(true);
        setCanSaveProfile(false);
      }
    } catch (e) {
      if (e instanceof ClientApiError && e.status === 404) {
        setDenied(!canReadRoster); // self endpoint 404 → no technician profile
        return;
      }
      setLoadError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [id, user, canReadRoster, canUpdate, canManageAny]);

  useEffect(() => { load(); }, [load]);

  // ── Dirty-state wiring (central router guard + data protection) ──
  const dirty = !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial);
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function submitEdit() {
    if (!tech || !form || !canSaveProfile) return;
    // Manual rate validation — kept exactly from the dialog editor.
    const rateNum = parseFloat(form.rate);
    if (form.rate !== "" && (isNaN(rateNum) || rateNum < 0)) {
      toast({ title: "Invalid hourly rate", description: "Enter a number, e.g. 55.25", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      // NOTE: no `skills` here — the structured store + API-maintained CSV
      // mirror are canonical now; sending stale text would clobber the mirror.
      await api.patch(`/api/v1/technicians/${tech.id}`, {
        specialty: form.specialty || undefined,
        hourlyRate: form.rate === "" ? 0 : toCents(form.rate) / 100, // decimal BND
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

  const displayName = tech?.user.name ?? "Technician";

  if (loading || !user) {
    return (
      <PageShell backLabel="Back to Technicians" backHref="/technicians" title="Edit Skills & Rate">
        <LoadingState label="Loading technician…" rows={3} />
      </PageShell>
    );
  }

  if (denied) {
    return (
      <PageShell
        backLabel="Back to Technicians"
        backHref="/technicians"
        crumbs={[{ label: "Technicians", href: "/technicians" }, { label: "Edit Skills & Rate" }]}
        title="Edit Skills & Rate"
      >
        <EmptyState
          title="You don't have permission to edit technicians"
          hint="Technician updates are limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  if (loadError && !tech) {
    return (
      <PageShell backLabel="Back to Technicians" backHref="/technicians" title="Edit Skills & Rate">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!tech) {
    return (
      <PageShell backLabel="Back to Technicians" backHref="/technicians" title="Edit Skills & Rate">
        <EmptyState title="Technician profile not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const set = (patch: Partial<TechForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const actions = (
    <>
      <Button variant="outline" onClick={() => navigateTo("technicians")} disabled={saving}>Cancel</Button>
      {canSaveProfile ? (
        <Button onClick={submitEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
      ) : null}
    </>
  );

  return (
    <PageShell
      backLabel="Back to Technicians"
      backHref="/technicians"
      crumbs={[
        { label: "Technicians", href: "/technicians" },
        { label: displayName },
        { label: canSaveProfile ? "Edit Skills & Rate" : "Skills" },
      ]}
      title={canSaveProfile ? `Edit ${displayName}` : `Skills — ${displayName}`}
      description={`${tech.employeeNo} · ${canSaveProfile ? "skills, specialty and billing rate." : "skill profile (specialty and rate are managed by administrators)."}`}
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{actions}</div>}
    >
      <div className="max-w-2xl space-y-4">
        {/* Skills manager — structured entries; editable per RBAC above */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">Skills</CardTitle>
                <CardDescription>Trade skills with level, certification and experience.</CardDescription>
              </div>
              <StatusBadge status={tech.status} />
            </div>
          </CardHeader>
          <CardContent>
            <SkillsManager
              profileId={tech.id}
              skills={skills}
              canEdit={canEditSkills}
              onChange={setSkills}
            />
          </CardContent>
        </Card>

        {/* Specialty / rate — editable only for users.update holders */}
        {form ? (
          <form
            onSubmit={(e) => { e.preventDefault(); submitEdit(); }}
            className="space-y-4"
          >
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Profile details</CardTitle>
                <CardDescription>Specialty shown on the roster and the billing rate.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
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
                  <Label htmlFor="t-rate">Hourly rate (BND)</Label>
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
        ) : (
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Profile details</CardTitle>
              <CardDescription>Read-only — managed by administrators.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Specialty</div>
                <div className="font-medium">{tech.specialty !== "GENERAL" ? humanize(tech.specialty) : "Generalist"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Hourly rate</div>
                <div className="font-medium">{tech.hourlyRateCents > 0 ? `B$ ${(tech.hourlyRateCents / 100).toFixed(2)}/h` : "—"}</div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </PageShell>
  );
}
