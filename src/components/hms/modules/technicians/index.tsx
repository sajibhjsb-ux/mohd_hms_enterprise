"use client";

// MOHD.HMS ENTERPRISE — Technicians module (workforce roster).
// Cards with skills chips + live workload counts. Data: /api/v1/technicians (users.read).
//
// NAVIGATION ARCHITECTURE: the rate/skills editor is a DEDICATED PAGE routed
// by the hash router (ui-store pages["technicians"]) — no popup CRUD:
//   []                  → this list page (card grid)
//   [id]                → detail view → falls back to the edit page
//                         (technicians have no separate detail page)
//   [id, "edit"]        → TechnicianEditPage (skills, specialty, hourly rate)
// The per-card duty-status Select stays INLINE on purpose: it is a quick
// action (PATCH /api/v1/technicians/{id} { status }), not a form.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, StatCard, StatusBadge, LoadingState, ErrorState, EmptyState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { hasPerm } from "@/components/hms/session";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { money } from "@/lib/hms/format";
import { CircleCheck, ClipboardList, HardHat, Hourglass, Pencil, RefreshCw } from "lucide-react";
import { TechnicianEditPage, parseSkills, type TechRow } from "./edit-page";
import { SkillLevelBadge } from "./skills-manager";

// ── Module router ──

export function TechniciansModule() {
  const seg = useUi((s) => s.pages["technicians"]) ?? [];
  const page = pageFromSeg(seg);

  // "detail" view falls back to the edit page — technicians have no separate detail page.
  if ((page.view === "edit" || page.view === "detail") && page.id) return <TechnicianEditPage id={page.id} />;
  return <TechniciansList />;
}

// ── List page (card grid) ──

const TECH_STATUSES = ["AVAILABLE", "ON_JOB", "OFF_DUTY"] as const;

function TechniciansList() {
  const { user } = useSession();
  const { toast } = useToast();
  const canUpdate = hasPerm(user, PERMISSIONS.users_update);
  // The skills editor page serves both admins (full edit) and supervisors
  // (technicians.manage — skills only). Both may OPEN the page; the edit page
  // decides what is editable inside.
  const canOpenEditor = canUpdate || hasPerm(user, PERMISSIONS.technicians_manage);

  const [rows, setRows] = useState<TechRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<TechRow[]>(`/api/v1/technicians${qs({ pageSize: 100, sort: "name", dir: "asc" })}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Quick action, kept inline: PATCH { status } only.
  async function changeStatus(t: TechRow, status: string) {
    setBusyId(t.id);
    try {
      await api.patch(`/api/v1/technicians/${t.id}`, { status });
      setRows((rs) => rs.map((r) => (r.id === t.id ? { ...r, status } : r)));
      toast({ title: "Status updated", description: `${t.user.name} is now ${statusLabel(status).toLowerCase()}.` });
    } catch (e) {
      toast({ title: "Could not update status", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
      load();
    } finally {
      setBusyId(null);
    }
  }

  const openEdit = useCallback((t: TechRow) => navigateTo("technicians", [t.id, "edit"]), []);

  const available = rows.filter((r) => r.status === "AVAILABLE").length;
  const onJob = rows.filter((r) => r.status === "ON_JOB").length;
  const totalOpenWO = rows.reduce((s, r) => s + r.openWorkOrders, 0);

  return (
    <div>
      <PageHeader
        title="Technicians"
        subtitle="Roster, skills and live workload"
        actions={
          <Button variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard title="Technicians" value={rows.length} icon={<HardHat className="h-5 w-5" />} loading={loading} />
        <StatCard title="Available" value={available} tone="success" loading={loading} />
        <StatCard title="On job" value={onJob} tone="warning" loading={loading} />
        <StatCard title="Open work orders" value={totalOpenWO} icon={<ClipboardList className="h-5 w-5" />} loading={loading} />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <LoadingState label="Loading technicians…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No technician profiles yet"
          hint="Create a user with the TECHNICIAN role (Users module) — a profile is provisioned automatically."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {rows.map((t) => (
            <div key={t.id} className="rounded-xl border bg-card shadow-sm p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {canOpenEditor ? (
                    <button
                      type="button"
                      onClick={() => openEdit(t)}
                      className="font-medium truncate max-w-full text-left hover:underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Edit skills and rate for ${t.user.name}`}
                    >
                      {t.user.name}
                    </button>
                  ) : (
                    <div className="font-medium truncate">{t.user.name}</div>
                  )}
                  <div className="text-xs text-muted-foreground truncate">
                    {t.employeeNo} · {t.specialty !== "GENERAL" ? humanizeSpecialty(t.specialty) : "Generalist"}
                  </div>
                </div>
                <StatusBadge status={t.status} />
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-muted/60 py-2">
                  <div className="text-lg font-semibold leading-none">{t.openWorkOrders}</div>
                  <div className="text-[11px] text-muted-foreground mt-1">open WOs</div>
                </div>
                <div className="rounded-lg bg-muted/60 py-2">
                  <div className="text-lg font-semibold leading-none flex items-center justify-center gap-1">
                    {t.completedWorkOrders}
                    <CircleCheck className="h-3.5 w-3.5 text-emerald-600" />
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">completed</div>
                </div>
                <div className="rounded-lg bg-muted/60 py-2">
                  <div className="text-lg font-semibold leading-none">{t.openComplaints + t.openPmTasks}</div>
                  <div className="text-[11px] text-muted-foreground mt-1 flex items-center justify-center gap-0.5">
                    <Hourglass className="h-3 w-3" /> queues
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-1 min-h-[22px]">
                {t.skillEntries && t.skillEntries.length > 0 ? (
                  // Structured entries (spec §6) — name + level, category on hover.
                  t.skillEntries.map((s) => (
                    <Badge
                      key={s.id}
                      variant="secondary"
                      className="text-[11px] font-normal gap-1"
                      title={humanize(s.category)}
                    >
                      <span className="max-w-[140px] truncate">{s.name}</span>
                      <SkillLevelBadge level={s.level} className="scale-[0.85] -mx-1" />
                    </Badge>
                  ))
                ) : parseSkills(t.skills).length === 0 ? (
                  <span className="text-xs text-muted-foreground">No skills listed</span>
                ) : (
                  parseSkills(t.skills).map((s) => (
                    <Badge key={s} variant="secondary" className="text-[11px] font-normal">{s}</Badge>
                  ))
                )}
              </div>

              <div className="flex items-center justify-between gap-2 mt-auto pt-1">
                <div className="text-sm">
                  <span className="text-muted-foreground text-xs">Rate</span>{" "}
                  <span className="font-medium">{t.hourlyRateCents > 0 ? `${money(t.hourlyRateCents)}/h` : "—"}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {canUpdate ? (
                    <>
                      <Select value={t.status} onValueChange={(v) => changeStatus(t, v)} disabled={busyId === t.id}>
                        <SelectTrigger className="h-8 w-[120px]" aria-label={`Duty status for ${t.user.name}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TECH_STATUSES.map((s) => <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => openEdit(t)} aria-label={`Edit rate and skills for ${t.user.name}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </>
                  ) : canOpenEditor ? (
                    <Button variant="outline" size="sm" className="h-8" onClick={() => openEdit(t)} aria-label={`Edit skills for ${t.user.name}`}>
                      <Pencil className="h-4 w-4 mr-1.5" /> Skills
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusLabel(s: string): string {
  return { AVAILABLE: "Available", ON_JOB: "On job", OFF_DUTY: "Off duty" }[s] ?? s;
}

function humanizeSpecialty(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
