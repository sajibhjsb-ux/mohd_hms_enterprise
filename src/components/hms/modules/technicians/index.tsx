"use client";

// MOHD.HMS ENTERPRISE — Technicians module (workforce roster).
// Cards with skills chips + live workload counts, inline duty status change
// and an hourly-rate / skills editor. Data: /api/v1/technicians (users.read).

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, StatCard, StatusBadge, LoadingState, ErrorState, EmptyState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import type { Permission } from "@/lib/hms/constants";
import { money, fromCents, toCents } from "@/lib/hms/format";
import { CircleCheck, ClipboardList, HardHat, Hourglass, Pencil, RefreshCw } from "lucide-react";

type TechRow = {
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

const TECH_STATUSES = ["AVAILABLE", "ON_JOB", "OFF_DUTY"] as const;

export function TechniciansModule() {
  const { user } = useSession();
  const { toast } = useToast();
  const can = (p: Permission) => !!user?.permissions.includes(p);

  const [rows, setRows] = useState<TechRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Rate / skills editor
  const [editRow, setEditRow] = useState<TechRow | null>(null);
  const [editSkills, setEditSkills] = useState("");
  const [editSpecialty, setEditSpecialty] = useState("");
  const [editRate, setEditRate] = useState("");
  const [saving, setSaving] = useState(false);

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

  function parseSkills(s: string): string[] {
    return s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
  }

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

  const openEdit = (t: TechRow) => {
    setEditRow(t);
    setEditSkills(t.skills);
    setEditSpecialty(t.specialty);
    setEditRate(fromCents(t.hourlyRateCents));
  };

  async function submitEdit() {
    if (!editRow) return;
    const rateNum = parseFloat(editRate);
    if (editRate !== "" && (isNaN(rateNum) || rateNum < 0)) {
      toast({ title: "Invalid hourly rate", description: "Enter a number, e.g. 55.25", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/api/v1/technicians/${editRow.id}`, {
        skills: editSkills,
        specialty: editSpecialty || undefined,
        hourlyRate: editRate === "" ? 0 : toCents(editRate) / 100, // decimal ringgit
      });
      toast({ title: "Technician updated", description: `${editRow.user.name} saved.` });
      setEditRow(null);
      load();
    } catch (e) {
      toast({ title: "Could not update technician", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

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
                  <div className="font-medium truncate">{t.user.name}</div>
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
                {parseSkills(t.skills).length === 0 ? (
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
                  {can("users.update") ? (
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
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Rate / skills editor */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit {editRow?.user.name}</DialogTitle>
            <DialogDescription>{editRow?.employeeNo} · skills, specialty and billing rate.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="t-skills">Skills (comma separated)</Label>
              <Input id="t-skills" value={editSkills} onChange={(e) => setEditSkills(e.target.value)} placeholder="e.g. HVAC, ELECTRICAL, PLUMBING" />
              {editSkills ? (
                <div className="flex flex-wrap gap-1 mt-2">
                  {parseSkills(editSkills).map((s) => <Badge key={s} variant="secondary" className="text-[11px] font-normal">{s}</Badge>)}
                </div>
              ) : null}
            </div>
            <div>
              <Label htmlFor="t-specialty">Specialty</Label>
              <Input id="t-specialty" value={editSpecialty} onChange={(e) => setEditSpecialty(e.target.value)} placeholder="e.g. ELECTRICAL" />
            </div>
            <div>
              <Label htmlFor="t-rate">Hourly rate (MYR)</Label>
              <Input id="t-rate" inputMode="decimal" value={editRate} onChange={(e) => setEditRate(e.target.value)} placeholder="e.g. 55.25" />
              {editRate !== "" && !isNaN(parseFloat(editRate)) ? (
                <p className="text-xs text-muted-foreground mt-1">Stored as {toCents(editRate).toLocaleString()} cents/hour</p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function statusLabel(s: string): string {
  return { AVAILABLE: "Available", ON_JOB: "On job", OFF_DUTY: "Off duty" }[s] ?? s;
}

function humanizeSpecialty(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
