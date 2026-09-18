"use client";

// MOHD.HMS ENTERPRISE — Assign Technician (dedicated full page, /complaints/{id}/assign).
// Replaces the former in-dialog assign section per the page-navigation
// architecture: complaint information + technician selector + note + action.
// Same API as before: POST /api/v1/complaints/{id}/transition {action:"assign"}.

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { PriorityBadge, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { customerLabel, fmtDateTime } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Send } from "lucide-react";

type AssignableComplaint = {
  id: string;
  code: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  createdAt: string;
  customer?: { id: string; companyName: string; contactPerson?: string } | null;
  equipment?: { id: string; name: string; assetTag: string } | null;
  assignedTechnician?: { id: string; user?: { name: string } | null } | null;
};

type TechOpt = { id: string; employeeNo?: string; specialty?: string; user?: { name?: string } | null };

export function ComplaintAssignPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canAssign = hasPerm(user, PERMISSIONS.complaints_assign);

  const [complaint, setComplaint] = useState<AssignableComplaint | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [techs, setTechs] = useState<TechOpt[]>([]);
  const [techsLoaded, setTechsLoaded] = useState(false);
  const [assignTo, setAssignTo] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<AssignableComplaint>(`/api/v1/complaints/${id}`);
      setComplaint(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this complaint.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!canAssign) return;
    let alive = true;
    api.get<TechOpt[]>(`/api/v1/technicians${qs({ pageSize: 200 })}`)
      .then((r) => { if (alive) setTechs(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setTechs([]); })
      .finally(() => { if (alive) setTechsLoaded(true); });
    return () => { alive = false; };
  }, [canAssign]);

  async function assign() {
    if (!complaint || !assignTo) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/complaints/${complaint.id}/transition`, {
        action: "assign",
        technicianId: assignTo,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast({ title: "Technician assigned", description: `${complaint.code} was assigned successfully.` });
      navigateTo("complaints", [complaint.id]);
    } catch (e) {
      toast({ title: "Assignment failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  if (!canAssign) {
    return (
      <PageShell backLabel="Back to Complaints" backHref="/complaints" title="Assign technician">
        <EmptyState
          title="You don't have permission to assign complaints"
          hint="Assignment is limited to supervisors, admins and super admins. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  if (loading && !complaint) {
    return (
      <PageShell backLabel="Back to Complaints" backHref="/complaints" title="Assign technician">
        <LoadingState label="Loading complaint…" rows={3} />
      </PageShell>
    );
  }

  if (loadError && !complaint) {
    return (
      <PageShell backLabel="Back to Complaints" backHref="/complaints" title="Assign technician">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!complaint) {
    return (
      <PageShell backLabel="Back to Complaints" backHref="/complaints" title="Assign technician">
        <EmptyState title="Complaint not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  if (complaint.status !== "NEW") {
    return (
      <PageShell
        backLabel="Back to Complaints"
        backHref="/complaints"
        crumbs={[{ label: "Complaints", href: "/complaints" }, { label: complaint.code, href: `/complaints/${encodeURIComponent(complaint.id)}` }, { label: "Assign" }]}
        title="Assign technician"
        description="This complaint is no longer awaiting assignment."
      >
        <EmptyState
          title={`Status is ${humanize(complaint.status)}`}
          hint="Only NEW complaints can be assigned. Open the complaint to continue its workflow."
          action={<Button variant="outline" onClick={() => navigateTo("complaints", [complaint.id])}>Open complaint</Button>}
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Complaints"
      backHref={`/complaints/${encodeURIComponent(complaint.id)}`}
      crumbs={[{ label: "Complaints", href: "/complaints" }, { label: complaint.code, href: `/complaints/${encodeURIComponent(complaint.id)}` }, { label: "Assign technician" }]}
      title="Assign technician"
      description="Send this complaint to a technician to start the workflow."
      actions={
        <Button onClick={assign} disabled={busy || !assignTo}>
          {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
          {busy ? "Assigning…" : "Assign"}
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Complaint information */}
        <Card className="lg:col-span-2 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">{complaint.code}</span>
              <span>{complaint.title}</span>
              <StatusBadge status={complaint.status} />
              <PriorityBadge priority={complaint.priority} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Customer</p>
                <p>{customerLabel(complaint.customer)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Equipment</p>
                <p>{complaint.equipment ? `${complaint.equipment.name} (${complaint.equipment.assetTag})` : "—"}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Priority</p>
                <p><PriorityBadge priority={complaint.priority} /></p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Current status</p>
                <p><StatusBadge status={complaint.status} /></p>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs uppercase tracking-wide">Description</p>
              <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3">{complaint.description}</p>
            </div>
            <p className="text-xs text-muted-foreground">Logged {fmtDateTime(complaint.createdAt)}</p>
          </CardContent>
        </Card>

        {/* Assignment */}
        <Card className="shadow-sm h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Assignment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="assign-tech">Technician</Label>
              <Select value={assignTo} onValueChange={setAssignTo}>
                <SelectTrigger id="assign-tech" aria-label="Technician">
                  <SelectValue placeholder={techs.length ? "Select technician…" : techsLoaded ? "No technicians available" : "Loading technicians…"} />
                </SelectTrigger>
                <SelectContent>
                  {techs.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.user?.name ?? t.employeeNo ?? t.id}{t.specialty ? ` — ${humanize(t.specialty)}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {complaint.assignedTechnician?.user?.name ? (
                <p className="text-xs text-muted-foreground">Currently: {complaint.assignedTechnician.user.name}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="assign-note">Note (optional)</Label>
              <Textarea
                id="assign-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Context for the technician…"
                rows={3}
              />
            </div>
            <Button className="w-full" onClick={assign} disabled={busy || !assignTo}>
              {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
              {busy ? "Assigning…" : "Assign technician"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
