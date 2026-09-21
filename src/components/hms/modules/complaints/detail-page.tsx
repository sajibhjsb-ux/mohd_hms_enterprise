"use client";

// MOHD.HMS ENTERPRISE — Complaint Detail (dedicated full page).
// Replaces the former detail dialog: same data, same workflow actions, same
// APIs (GET /complaints/{id}, POST /complaints/{id}/transition) — no popup.
// Technician assignment lives on its own page (/complaints/{id}/assign).

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { PriorityBadge, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { WorkflowTimeline } from "@/components/hms/shared/workflow-timeline";
import { PdfButtons } from "@/components/hms/shared/pdf-buttons";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { customerLabel, fmtDateTime } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { COMPLAINT_DETAIL_EVENTS } from "@/lib/hms/realtime/matrix";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowUpRight, CheckCircle2, ClipboardCheck, Hammer, Lock, Pencil, UserPlus,
} from "lucide-react";

type HistoryRow = {
  id: string;
  fromStatus: string;
  toStatus: string;
  note: string;
  createdAt: string;
  changedByName?: string | null;
};

type ComplaintDetail = {
  id: string;
  code: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  createdAt: string;
  customerId: string;
  resolutionNotes?: string;
  customerFeedback?: string;
  assignedTechnician?: { id: string; user?: { id: string; name: string } | null } | null;
  customer?: { id: string; companyName: string; contactPerson?: string } | null;
  equipment?: { id: string; name: string; assetTag: string } | null;
  statusHistory: HistoryRow[];
  workOrders: { id: string; code: string; title: string; status: string; technician?: { user?: { name: string } | null } | null }[];
};

export function ComplaintDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();

  const [detail, setDetail] = useState<ComplaintDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const canUpdate = hasPerm(user, PERMISSIONS.complaints_update);
  const canClose = hasPerm(user, PERMISSIONS.complaints_close);
  const isStaffUser = !!user && user.role !== "CUSTOMER";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<ComplaintDetail>(`/api/v1/complaints/${id}`);
      setDetail(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this complaint.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Realtime: this complaint's status changes (by any authorized user) refresh
  // the detail view live — the timeline stays current without a refresh.
  useRealtimeEvent(COMPLAINT_DETAIL_EVENTS, (ev) => {
    if (!ev.aggregate_id || ev.aggregate_id === id) void load();
  });

  const runTransition = useCallback(async (action: string, extra?: Record<string, unknown>) => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await api.post<ComplaintDetail>(`/api/v1/complaints/${detail.id}/transition`, { action, ...extra });
      // Stay on the detail page — refresh with the authoritative server record.
      setDetail(res.data);
      setNote("");
      toast({ title: "Success", description: `Complaint ${detail.code} — ${humanize(action)} done.` });
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [detail, toast]);

  // ── Action visibility (same rules as the workflow) ──
  const isAssignedTech = !!detail && !!user && detail.assignedTechnician?.user?.id === user.id;
  const isPortalOwner = !!detail && !!user && user.role === "CUSTOMER" && user.customerId === detail.customerId;
  const status = detail?.status;

  // §11/§13/§14 — link lock state mirrors the BACKEND guards exactly: closure
  // is blocked while any linked work order is active; cancellation is blocked
  // once any (non-cancelled) work order exists. The backend enforces this for
  // direct API calls too — the UI merely reflects it.
  const ACTIVE_WO_STATUSES = ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"];
  const activeWorkOrder = detail?.workOrders.find((w) => ACTIVE_WO_STATUSES.includes(w.status)) ?? null;
  const settledWorkOrder = detail?.workOrders.find((w) => !ACTIVE_WO_STATUSES.includes(w.status) && w.status !== "CANCELLED") ?? null;
  const cancelLocked = !!(activeWorkOrder ?? settledWorkOrder);

  if (loading && !detail) {
    return (
      <PageShell backLabel="Back to Complaints" backHref="/complaints" title="Complaint details">
        <LoadingState label="Loading complaint…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !detail) {
    return (
      <PageShell backLabel="Back to Complaints" backHref="/complaints" title="Complaint details">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!detail) {
    return (
      <PageShell backLabel="Back to Complaints" backHref="/complaints" title="Complaint details">
        <EmptyState title="Complaint not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Complaints"
      backHref="/complaints"
      crumbs={[{ label: "Complaints", href: "/complaints" }, { label: detail.code }]}
      title={detail.title}
      description={`${customerLabel(detail.customer)}${detail.equipment ? ` · ${detail.equipment.name} (${detail.equipment.assetTag})` : ""} · Logged ${fmtDateTime(detail.createdAt)}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {status === "NEW" && (canUpdate || isPortalOwner) ? (
            <Button variant="outline" size="sm" onClick={() => navigateTo("complaints", [detail.id, "edit"])}>
              <Pencil className="h-4 w-4 mr-1.5" /> Edit
            </Button>
          ) : null}
          <StatusBadge status={detail.status} />
          <PriorityBadge priority={detail.priority} />
          <PdfButtons type="complaint" id={detail.id} label={`Complaint ${detail.code}`} />
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-4">
          {/* ── Chapter 12 — conversion display. The linked Work Order itself is
              the conversion indicator — there is intentionally NO "Converted:
              YES" flag anywhere. The WO code opens the REAL work order detail
              page through the existing router (never a modal). ── */}
          {detail.workOrders.length > 0 ? (
            <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4">
              <p className="text-muted-foreground text-xs uppercase tracking-wide">
                {detail.workOrders.length > 1 ? "Linked work orders" : "Linked work order"}
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Complaint status</p>
                  <StatusBadge status={detail.status} />
                </div>
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Linked work order</p>
                  <button
                    type="button"
                    onClick={() => navigateTo("work-orders", [detail.workOrders[0].id])}
                    title={detail.workOrders[0].title || undefined}
                    aria-label={`Open work order ${detail.workOrders[0].code}`}
                    className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-sm text-primary hover:bg-accent/60 transition-colors min-h-[44px] sm:min-h-0"
                  >
                    {detail.workOrders[0].code}
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Work order status</p>
                  <StatusBadge status={detail.workOrders[0].status} />
                </div>
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Technician</p>
                  <p>{detail.workOrders[0].technician?.user?.name ?? "Unassigned"}</p>
                </div>
              </div>
              {/* §13/§18 — cancellation lock reason, shown while the linked WO
                  is unsettled; not applicable once it is final. */}
              {activeWorkOrder ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground border-t pt-3">
                  <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Cancellation: LOCKED — the complaint cannot be cancelled while the linked work order is active.
                </p>
              ) : null}
              {detail.workOrders.length > 1 ? (
                <div className="space-y-2 border-t pt-3">
                  {detail.workOrders.slice(1).map((w) => (
                    <div key={w.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <button
                        type="button"
                        onClick={() => navigateTo("work-orders", [w.id])}
                        title={w.title || undefined}
                        aria-label={`Open work order ${w.code}`}
                        className="inline-flex items-center gap-1 font-mono text-primary hover:underline min-h-[44px] sm:min-h-0"
                      >
                        {w.code}
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <StatusBadge status={w.status} />
                      {w.technician?.user?.name ? <span className="text-xs text-muted-foreground">{w.technician.user.name}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-mono text-muted-foreground">{detail.code}</span>
              <span className="text-xs text-muted-foreground">{fmtDateTime(detail.createdAt)}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 text-sm">
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Technician</p>
                <p>{detail.assignedTechnician?.user?.name ?? "Unassigned"}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Reported</p>
                <p>{fmtDateTime(detail.createdAt)}</p>
              </div>
            </div>
            <div className="text-sm space-y-1">
              <p className="text-muted-foreground text-xs uppercase tracking-wide">Description</p>
              <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3">{detail.description}</p>
            </div>
            {detail.resolutionNotes ? (
              <div className="text-sm space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Resolution notes</p>
                <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3">{detail.resolutionNotes}</p>
              </div>
            ) : null}
            {detail.customerFeedback ? (
              <div className="text-sm space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Customer feedback</p>
                <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3">{detail.customerFeedback}</p>
              </div>
            ) : null}
          </div>

          {/* Timeline */}
          <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 text-sm">
            <p className="text-muted-foreground text-xs uppercase tracking-wide mb-3">Status timeline</p>
            {detail.statusHistory.length === 0 ? (
              <p className="text-muted-foreground">No history recorded.</p>
            ) : (
              <ol className="relative border-l ml-2 space-y-3">
                {detail.statusHistory.map((h) => (
                  <li key={h.id} className="ml-4">
                    <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={h.toStatus} />
                      <span className="text-xs text-muted-foreground">{fmtDateTime(h.createdAt)}</span>
                      {h.changedByName ? <Badge variant="outline" className="text-[10px]">{h.changedByName}</Badge> : null}
                    </div>
                    {h.note ? <p className="text-xs text-muted-foreground mt-0.5">{h.note}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>

        </div>

        {/* Action column — contextual to role and status */}
        <div className="space-y-3">
          {status === "NEW" && isStaffUser ? (
            <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
              <p className="text-sm font-medium">Assign technician</p>
              <p className="text-xs text-muted-foreground">Send this complaint to a technician to start the workflow.</p>
              <Button className="w-full" onClick={() => navigateTo("complaints", [detail.id, "assign"])}>
                <UserPlus className="h-4 w-4 mr-1.5" /> Open assignment page
              </Button>
            </div>
          ) : null}

          {status === "ASSIGNED" && isAssignedTech ? (
            <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
              <p className="text-sm">This complaint is assigned to you. Accept to start work?</p>
              <Button disabled={busy} onClick={() => runTransition("accept")} className="w-full">
                <Hammer className="h-4 w-4 mr-1.5" /> Accept &amp; Start Work
              </Button>
            </div>
          ) : null}

          {status === "IN_PROGRESS" && (isAssignedTech || canUpdate) ? (
            <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
              <Label htmlFor="complete-note" className="text-xs uppercase tracking-wide text-muted-foreground">Resolution notes</Label>
              <Textarea id="complete-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done to resolve this complaint…" rows={3} />
              <Button disabled={busy} onClick={() => runTransition("complete", { note: note || undefined })} className="w-full">
                <CheckCircle2 className="h-4 w-4 mr-1.5" /> Mark Completed
              </Button>
            </div>
          ) : null}

          {status === "COMPLETED" && (isPortalOwner || canUpdate) ? (
            <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
              <Label htmlFor="confirm-note" className="text-xs uppercase tracking-wide text-muted-foreground">Confirm resolution{isPortalOwner ? "" : " (on behalf of customer)"}</Label>
              <Textarea id="confirm-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional feedback…" rows={2} />
              <Button disabled={busy} onClick={() => runTransition("confirm", { note: note || undefined })} className="w-full">
                <CheckCircle2 className="h-4 w-4 mr-1.5" /> Confirm Resolved
              </Button>
            </div>
          ) : null}

          {status === "CONFIRMED" && canClose ? (
            activeWorkOrder ? (
              // §11 — the backend rejects closure while the linked WO is active;
              // the UI shows the honest BLOCKED state instead of a dead button.
              <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 shadow-sm p-4 space-y-1.5">
                <p className="text-sm font-medium flex items-center gap-1.5"><Lock className="h-4 w-4" aria-hidden /> Close blocked</p>
                <p className="text-xs text-muted-foreground">
                  Closure blocked. The linked Work Order {activeWorkOrder.code} is still active.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
                <p className="text-sm">Customer confirmed. Close this complaint to archive it?</p>
                <Button variant="outline" disabled={busy} onClick={() => runTransition("close")} className="w-full">
                  <ClipboardCheck className="h-4 w-4 mr-1.5" /> Close Complaint
                </Button>
              </div>
            )
          ) : null}

          {status && ["NEW", "ASSIGNED", "IN_PROGRESS"].includes(status) && isStaffUser ? (
            cancelLocked ? (
              // §13 — cancellation is locked once a work order exists; the
              // backend rejects it for direct API calls as well.
              <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 shadow-sm p-4 space-y-1.5">
                <p className="text-sm font-medium flex items-center gap-1.5"><Lock className="h-4 w-4" aria-hidden /> Cancellation LOCKED</p>
                <p className="text-xs text-muted-foreground">
                  The complaint cannot be cancelled while the linked work order is active.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-destructive/30 bg-card shadow-sm p-4 space-y-2">
                <p className="text-sm text-muted-foreground">Cancelling stops the workflow permanently.</p>
                <Button variant="destructive" disabled={busy} onClick={() => setConfirmCancel(true)} className="w-full">
                  Cancel Complaint
                </Button>
              </div>
            )
          ) : null}
        </div>
      </div>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel complaint {detail.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the workflow permanently and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep complaint</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => runTransition("cancel")}
            >
              Cancel complaint
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <WorkflowTimeline resourceType="COMPLAINT" resourceId={detail.id} className="mt-6" />

      <Separator className="opacity-0" />
    </PageShell>
  );
}
