"use client";

// MOHD.HMS ENTERPRISE — Complaints module.
// Customer portal + staff workflow: NEW → ASSIGNED → IN_PROGRESS → COMPLETED →
// CONFIRMED → CLOSED (+ CANCELLED). Role-gated actions, live status timeline,
// draft-protected creation form.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  PageHeader, StatCard, StatusBadge, PriorityBadge, LoadingState, EmptyState, ErrorState,
} from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, PRIORITIES, humanize } from "@/lib/hms/constants";
import { fmtDate, fmtDateTime } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertTriangle, CheckCircle2, ClipboardCheck, Clock, Hammer, ListChecks, Plus, Send,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type ComplaintRow = {
  id: string;
  code: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  createdAt: string;
  customerId: string;
  customer?: { id: string; companyName: string } | null;
  equipment?: { id: string; name: string; assetTag: string } | null;
  assignedTechnician?: { id: string; user?: { id: string; name: string } | null } | null;
};

type HistoryRow = {
  id: string;
  fromStatus: string;
  toStatus: string;
  note: string;
  createdAt: string;
  changedByName?: string | null;
};

type ComplaintDetail = ComplaintRow & {
  resolutionNotes: string;
  customerFeedback: string;
  assignedAt: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  confirmedAt: string | null;
  closedAt: string | null;
  statusHistory: HistoryRow[];
  workOrders: { id: string; code: string; title: string; status: string; technician?: { user?: { name: string } | null } | null }[];
};

type TechOpt = { id: string; employeeNo?: string; specialty?: string; user?: { name?: string } | null };
type CustomerOpt = { id: string; companyName?: string; name?: string };
type EquipmentOpt = { id: string; name?: string; assetTag?: string };

type CreateForm = {
  title: string;
  description: string;
  priority: string;
  customerId: string;
  equipmentId: string;
};

const EMPTY_CREATE: CreateForm = { title: "", description: "", priority: "MEDIUM", customerId: "", equipmentId: "" };

const OPEN_STATUSES = ["NEW", "ASSIGNED"];
const PROGRESS_STATUSES = ["IN_PROGRESS"];
const RESOLVED_STATUSES = ["COMPLETED", "CONFIRMED"];

const STATUS_TABS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "ALL", label: "All", match: () => true },
  { key: "OPEN", label: "Open", match: (s) => OPEN_STATUSES.includes(s) },
  { key: "IN_PROGRESS", label: "In Progress", match: (s) => PROGRESS_STATUSES.includes(s) },
  { key: "RESOLVED", label: "Resolved", match: (s) => RESOLVED_STATUSES.includes(s) },
  { key: "CLOSED", label: "Closed", match: (s) => s === "CLOSED" },
  { key: "CANCELLED", label: "Cancelled", match: (s) => s === "CANCELLED" },
];

// ── Module ──

export function ComplaintsModule() {
  const { user } = useSession();
  const { toast } = useToast();

  const canCreate = hasPerm(user, PERMISSIONS.complaints_create);
  const canAssign = hasPerm(user, PERMISSIONS.complaints_assign);
  const canUpdate = hasPerm(user, PERMISSIONS.complaints_update);
  const canClose = hasPerm(user, PERMISSIONS.complaints_close);
  const isStaffUser = !!user && user.role !== "CUSTOMER";

  // ── List state ──
  const [rows, setRows] = useState<ComplaintRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("ALL");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<ComplaintRow[]>(`/api/v1/complaints${qs({ pageSize: 200 })}`);
      setRows(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load complaints.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, reloadKey]);

  // ── Detail state ──
  const [detail, setDetail] = useState<ComplaintDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const [techs, setTechs] = useState<TechOpt[]>([]);
  const [assignTo, setAssignTo] = useState<string>("");

  const openDetail = useCallback(async (id: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    setNote("");
    setAssignTo("");
    try {
      const res = await api.get<ComplaintDetail>(`/api/v1/complaints/${id}`);
      setDetail(res.data);
    } catch (e) {
      toast({ title: "Could not load complaint", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }, [toast]);

  // Technician options for the assign control
  useEffect(() => {
    if (!detailOpen || !canAssign) return;
    let alive = true;
    api.get<TechOpt[]>(`/api/v1/technicians${qs({ pageSize: 200 })}`)
      .then((r) => { if (alive) setTechs(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setTechs([]); });
    return () => { alive = false; };
  }, [detailOpen, canAssign]);

  const runTransition = useCallback(async (action: string, extra?: Record<string, unknown>) => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.post<ComplaintDetail>(`/api/v1/complaints/${detail.id}/transition`, { action, ...extra });
      toast({ title: "Success", description: `Complaint ${detail.code} — ${humanize(action)} done.` });
      setDetailOpen(false);
      setDetail(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [detail, toast]);

  // ── Create dialog ──
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [customers, setCustomers] = useState<CustomerOpt[]>([]);
  const [equipment, setEquipment] = useState<EquipmentOpt[]>([]);
  const draft = useDraft<CreateForm>({ formKey: "complaint.create", initial: EMPTY_CREATE });

  useEffect(() => {
    if (!createOpen || !isStaffUser) return;
    let alive = true;
    api.get<CustomerOpt[]>(`/api/v1/customers${qs({ pageSize: 200 })}`)
      .then((r) => { if (alive) setCustomers(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setCustomers([]); });
    return () => { alive = false; };
  }, [createOpen, isStaffUser]);

  // Equipment options follow the selected customer (or the caller's own scope for portal users)
  useEffect(() => {
    if (!createOpen) return;
    if (isStaffUser && !draft.value.customerId) { setEquipment([]); return; }
    let alive = true;
    api.get<EquipmentOpt[]>(`/api/v1/equipment${qs({ customerId: draft.value.customerId || undefined, pageSize: 200 })}`)
      .then((r) => { if (alive) setEquipment(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setEquipment([]); });
    return () => { alive = false; };
  }, [createOpen, draft.value.customerId, isStaffUser]);

  async function submitCreate() {
    const v = draft.value;
    if (v.title.trim().length < 3 || v.description.trim().length < 3) {
      toast({ title: "Check the form", description: "Title and description need at least 3 characters.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        title: v.title.trim(),
        description: v.description.trim(),
        priority: v.priority,
        ...(isStaffUser && v.customerId ? { customerId: v.customerId } : {}),
        ...(v.equipmentId ? { equipmentId: v.equipmentId } : {}),
      };
      const res = await api.post<ComplaintRow>("/api/v1/complaints", payload);
      toast({ title: "Complaint created", description: `${res.data.code} logged successfully.` });
      draft.reset(EMPTY_CREATE);
      setCreateOpen(false);
      setReloadKey((k) => k + 1);
    } catch (e) {
      toast({ title: "Could not create complaint", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  // ── Derived views ──
  const stats = useMemo(() => {
    const list = rows ?? [];
    const count = (match: (r: ComplaintRow) => boolean) => list.filter(match).length;
    return {
      total: list.length,
      open: count((r) => OPEN_STATUSES.includes(r.status)),
      inProgress: count((r) => PROGRESS_STATUSES.includes(r.status)),
      resolved: count((r) => RESOLVED_STATUSES.includes(r.status)),
      closed: count((r) => r.status === "CLOSED"),
      urgent: count((r) => r.priority === "URGENT" && !["CLOSED", "CANCELLED"].includes(r.status)),
    };
  }, [rows]);

  const visibleRows = useMemo(() => {
    const active = STATUS_TABS.find((t) => t.key === tab) ?? STATUS_TABS[0];
    return (rows ?? []).filter((r) => active.match(r.status));
  }, [rows, tab]);

  const tabCount = (key: string) => {
    const active = STATUS_TABS.find((t) => t.key === key);
    if (!active) return 0;
    return (rows ?? []).filter((r) => active.match(r.status)).length;
  };

  const columns: Column<ComplaintRow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, className: "font-mono text-xs whitespace-nowrap" },
    { key: "title", header: "Title", value: (r) => r.title, className: "max-w-[260px] truncate" },
    { key: "priority", header: "Priority", render: (r) => <PriorityBadge priority={r.priority} />, value: (r) => r.priority },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} />, value: (r) => r.status },
    { key: "customer", header: "Customer", value: (r) => r.customer?.companyName ?? "", hideOnMobile: true },
    { key: "technician", header: "Technician", value: (r) => r.assignedTechnician?.user?.name ?? "", render: (r) => r.assignedTechnician?.user?.name ?? "—", hideOnMobile: true },
    { key: "equipment", header: "Equipment", value: (r) => r.equipment?.name ?? "", render: (r) => (r.equipment ? `${r.equipment.name} (${r.equipment.assetTag})` : "—"), hideOnMobile: true },
    { key: "createdAt", header: "Created", value: (r) => r.createdAt, render: (r) => fmtDate(r.createdAt), hideOnMobile: true },
  ];

  // ── Detail action visibility ──
  const isAssignedTech = !!detail && !!user && detail.assignedTechnician?.user?.id === user.id;
  const isPortalOwner = !!detail && !!user && user.role === "CUSTOMER" && user.customerId === detail.customerId;
  const status = detail?.status;

  return (
    <div>
      <PageHeader
        title="Complaints"
        subtitle={isStaffUser ? "Track, assign and resolve customer complaints end-to-end." : "Your complaints and their live progress."}
        actions={canCreate ? (
          <Button onClick={() => { setCreateOpen(true); }}>
            <Plus className="h-4 w-4 mr-1.5" /> New Complaint
          </Button>
        ) : null}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <StatCard title="Total" value={stats.total} icon={<ListChecks className="h-5 w-5" />} loading={!rows && loading} />
        <StatCard title="Open" value={stats.open} icon={<Clock className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="In Progress" value={stats.inProgress} icon={<Hammer className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="Resolved" value={stats.resolved} icon={<CheckCircle2 className="h-5 w-5" />} tone="success" loading={!rows && loading} />
        <StatCard title="Closed" value={stats.closed} icon={<ClipboardCheck className="h-5 w-5" />} loading={!rows && loading} />
        <StatCard title="Urgent Active" value={stats.urgent} icon={<AlertTriangle className="h-5 w-5" />} tone="danger" loading={!rows && loading} />
      </div>

      {/* Status tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
              tab === t.key ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted text-muted-foreground"
            )}
          >
            {t.label} <span className="opacity-70 tabular-nums">({tabCount(t.key)})</span>
          </button>
        ))}
      </div>

      {loading && !rows ? (
        <LoadingState label="Loading complaints…" rows={5} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          title="No complaints in this view"
          hint={canCreate ? "Log a new complaint to get started — drafts are saved automatically while you type." : "Complaints will appear here as they are filed."}
          action={canCreate ? <Button variant="outline" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> New Complaint</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={visibleRows}
          rowKey={(r) => r.id}
          onRowClick={(r) => openDetail(r.id)}
          searchPlaceholder="Search code, title, description…"
          filters={[{
            key: "priority",
            label: "Priorities",
            options: PRIORITIES.map((p) => ({ value: p, label: humanize(p) })),
            match: (row, value) => row.priority === value,
          }]}
          emptyTitle="No complaints match"
          exportName="complaints"
        />
      )}

      {/* ── Detail dialog ── */}
      <Dialog open={detailOpen} onOpenChange={(open) => { if (!open) { setDetailOpen(false); setDetail(null); } }}>
        <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto hms-scroll">
          <DialogTitle className="sr-only">Details</DialogTitle>
          {detailLoading || !detail ? (
            <LoadingState label="Loading complaint…" />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-muted-foreground">{detail.code}</span>
                  <span className="text-base">{detail.title}</span>
                  <StatusBadge status={detail.status} />
                  <PriorityBadge priority={detail.priority} />
                </DialogTitle>
                <DialogDescription>
                  {detail.customer?.companyName ?? "—"}
                  {detail.equipment ? ` · ${detail.equipment.name} (${detail.equipment.assetTag})` : ""}
                  {` · Logged ${fmtDateTime(detail.createdAt)}`}
                </DialogDescription>
              </DialogHeader>

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

              {/* Timeline */}
              <div className="text-sm">
                <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">Status timeline</p>
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

              {detail.workOrders.length > 0 ? (
                <div className="text-sm">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">Linked work orders</p>
                  <div className="flex flex-wrap gap-2">
                    {detail.workOrders.map((w) => (
                      <span key={w.id} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
                        <span className="font-mono">{w.code}</span>
                        <StatusBadge status={w.status} />
                        {w.technician?.user?.name ? <span className="text-muted-foreground">{w.technician.user.name}</span> : null}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <Separator />

              {/* Actions — contextual to role and status */}
              <div className="space-y-3">
                {status === "NEW" && canAssign ? (
                  <div className="rounded-lg border p-3 space-y-2">
                    <Label className="text-xs uppercase tracking-wide text-muted-foreground">Assign technician</Label>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Select value={assignTo} onValueChange={setAssignTo}>
                        <SelectTrigger className="flex-1" aria-label="Technician">
                          <SelectValue placeholder={techs.length ? "Select technician…" : "No technicians available"} />
                        </SelectTrigger>
                        <SelectContent>
                          {techs.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.user?.name ?? t.employeeNo ?? t.id}{t.specialty ? ` — ${humanize(t.specialty)}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button disabled={!assignTo || busy} onClick={() => runTransition("assign", { technicianId: assignTo })}>
                        <Send className="h-4 w-4 mr-1.5" /> Assign
                      </Button>
                    </div>
                  </div>
                ) : null}

                {status === "ASSIGNED" && isAssignedTech ? (
                  <div className="rounded-lg border p-3">
                    <p className="text-sm mb-2">This complaint is assigned to you. Accept to start work?</p>
                    <Button disabled={busy} onClick={() => runTransition("accept")}>
                      <Hammer className="h-4 w-4 mr-1.5" /> Accept &amp; Start Work
                    </Button>
                  </div>
                ) : null}

                {status === "IN_PROGRESS" && (isAssignedTech || canUpdate) ? (
                  <div className="rounded-lg border p-3 space-y-2">
                    <Label htmlFor="complete-note" className="text-xs uppercase tracking-wide text-muted-foreground">Resolution notes</Label>
                    <Textarea id="complete-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done to resolve this complaint…" rows={3} />
                    <Button disabled={busy} onClick={() => runTransition("complete", { note: note || undefined })}>
                      <CheckCircle2 className="h-4 w-4 mr-1.5" /> Mark Completed
                    </Button>
                  </div>
                ) : null}

                {status === "COMPLETED" && (isPortalOwner || canUpdate) ? (
                  <div className="rounded-lg border p-3 space-y-2">
                    <Label htmlFor="confirm-note" className="text-xs uppercase tracking-wide text-muted-foreground">Confirm resolution{isPortalOwner ? "" : " (on behalf of customer)"}</Label>
                    <Textarea id="confirm-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional feedback…" rows={2} />
                    <Button disabled={busy} onClick={() => runTransition("confirm", { note: note || undefined })}>
                      <CheckCircle2 className="h-4 w-4 mr-1.5" /> Confirm Resolved
                    </Button>
                  </div>
                ) : null}

                {status === "CONFIRMED" && canClose ? (
                  <div className="rounded-lg border p-3">
                    <p className="text-sm mb-2">Customer confirmed. Close this complaint to archive it?</p>
                    <Button variant="outline" disabled={busy} onClick={() => runTransition("close")}>
                      <ClipboardCheck className="h-4 w-4 mr-1.5" /> Close Complaint
                    </Button>
                  </div>
                ) : null}

                {status && ["NEW", "ASSIGNED", "IN_PROGRESS"].includes(status) && isStaffUser ? (
                  <div className="rounded-lg border border-destructive/30 p-3">
                    <p className="text-sm mb-2 text-muted-foreground">Cancelling stops the workflow permanently.</p>
                    <Button variant="destructive" disabled={busy} onClick={() => { if (window.confirm(`Cancel complaint ${detail.code}? This cannot be undone.`)) runTransition("cancel"); }}>
                      Cancel Complaint
                    </Button>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Create dialog ── */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) setCreateOpen(false); }}>
        <DialogContent className="max-w-xl max-h-[88vh] overflow-y-auto hms-scroll">
          <DialogHeader>
            <DialogTitle>New Complaint</DialogTitle>
            <DialogDescription>
              {isStaffUser ? "Log a complaint on behalf of a customer." : "Report an issue — our team will assign a technician."}
              {draft.draftExists ? " A draft was found — use Restore to recover it." : ""}
            </DialogDescription>
          </DialogHeader>

          {draft.draftExists ? (
            <div className="flex items-center justify-between rounded-lg border border-dashed p-2.5 text-sm">
              <span className="text-muted-foreground">Unsubmitted draft saved {draft.lastSavedAt ? fmtDateTime(draft.lastSavedAt) : "earlier"}.</span>
              <Button size="sm" variant="outline" onClick={draft.restore}>Restore</Button>
            </div>
          ) : null}

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="c-title">Title *</Label>
              <Input id="c-title" value={draft.value.title} onChange={(e) => draft.setValue({ title: e.target.value })} placeholder="Short summary of the issue" maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-desc">Description *</Label>
              <Textarea id="c-desc" value={draft.value.description} onChange={(e) => draft.setValue({ description: e.target.value })} placeholder="Describe the problem, location and impact…" rows={4} maxLength={5000} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={draft.value.priority} onValueChange={(v) => draft.setValue({ priority: v })}>
                  <SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {isStaffUser ? (
                <div className="space-y-1.5">
                  <Label>Customer *</Label>
                  <Select value={draft.value.customerId} onValueChange={(v) => draft.setValue({ customerId: v, equipmentId: "" })}>
                    <SelectTrigger aria-label="Customer"><SelectValue placeholder="Select customer…" /></SelectTrigger>
                    <SelectContent>
                      {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.companyName ?? c.name ?? c.id}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label>Equipment</Label>
              <Select value={draft.value.equipmentId} onValueChange={(v) => draft.setValue({ equipmentId: v })}>
                <SelectTrigger aria-label="Equipment">
                  <SelectValue placeholder={isStaffUser && !draft.value.customerId ? "Select a customer first…" : equipment.length ? "Optional — pick the equipment…" : "No equipment available"} />
                </SelectTrigger>
                <SelectContent>
                  {equipment.map((e) => <SelectItem key={e.id} value={e.id}>{e.name ?? e.id}{e.assetTag ? ` (${e.assetTag})` : ""}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {draft.dirty ? <p className="text-xs text-muted-foreground">Draft auto-saves as you type — safe to leave and restore later.</p> : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>Cancel</Button>
            <Button
              onClick={submitCreate}
              disabled={submitting || draft.value.title.trim().length < 3 || draft.value.description.trim().length < 3 || (isStaffUser && !draft.value.customerId)}
            >
              {submitting ? "Saving…" : "Create Complaint"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
