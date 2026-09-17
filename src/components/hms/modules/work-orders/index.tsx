"use client";

// MOHD.HMS ENTERPRISE — Work Orders module.
// PENDING → ACCEPTED → IN_PROGRESS → COMPLETED (+ ON_HOLD, CANCELLED).
// Checklist execution, materials with live totals, labour cost capture,
// role-gated transitions. Draft-protected creation form.

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
import { money, fmtDate, fmtDateTime, toCents } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CircleDollarSign, ClipboardList, Hammer, PauseCircle, PlayCircle, Plus, Trash2, Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type WORow = {
  id: string;
  code: string;
  title: string;
  status: string;
  priority: string;
  scheduledDate: string | null;
  totalCents: number;
  createdAt: string;
  customer?: { id: string; companyName: string } | null;
  equipment?: { id: string; name: string; assetTag: string } | null;
  technician?: { id: string; user?: { id: string; name: string } | null } | null;
  complaint?: { id: string; code: string } | null;
};

type ChecklistItem = { id: string; label: string; done: boolean; doneAt: string | null; sortOrder: number };
type MaterialRow = {
  id: string; name: string; quantity: number; unit: string; unitCostCents: number; totalCents: number;
  inventoryItemId: string | null; inventoryItem?: { id: string; name: string; unit: string } | null;
};

type WODetail = WORow & {
  description: string;
  notes: string;
  customerId: string;
  startedAt: string | null;
  completedAt: string | null;
  labourHours: number;
  labourRateCents: number;
  labourTotalCents: number;
  materialsTotalCents: number;
  checklist: ChecklistItem[];
  materials: MaterialRow[];
};

type TechOpt = { id: string; employeeNo?: string; specialty?: string; user?: { name?: string } | null };
type CustomerOpt = { id: string; companyName?: string; name?: string };
type EquipmentOpt = { id: string; name?: string; assetTag?: string };
type ComplaintOpt = { id: string; code: string; title: string; customer?: { id: string; companyName?: string } | null };

type WOMaterialForm = { name: string; qty: string; cost: string };
type WOCreateForm = {
  title: string;
  description: string;
  customerId: string;
  equipmentId: string;
  complaintId: string;
  technicianId: string;
  priority: string;
  scheduledDate: string;
  checklistText: string;
  materials: WOMaterialForm[];
};

const EMPTY_CREATE: WOCreateForm = {
  title: "", description: "", customerId: "", equipmentId: "", complaintId: "",
  technicianId: "", priority: "MEDIUM", scheduledDate: "", checklistText: "", materials: [],
};

const PENDING_STATUSES = ["PENDING", "ACCEPTED"];

const STATUS_TABS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "ALL", label: "All", match: () => true },
  { key: "PENDING", label: "Pending", match: (s) => PENDING_STATUSES.includes(s) },
  { key: "IN_PROGRESS", label: "In Progress", match: (s) => s === "IN_PROGRESS" },
  { key: "ON_HOLD", label: "On Hold", match: (s) => s === "ON_HOLD" },
  { key: "COMPLETED", label: "Completed", match: (s) => s === "COMPLETED" },
  { key: "CANCELLED", label: "Cancelled", match: (s) => s === "CANCELLED" },
];

export function WorkOrdersModule() {
  const { user } = useSession();
  const { toast } = useToast();

  const canCreate = hasPerm(user, PERMISSIONS.work_orders_create);
  const canAssign = hasPerm(user, PERMISSIONS.work_orders_assign);
  const canUpdate = hasPerm(user, PERMISSIONS.work_orders_update);
  const canComplete = hasPerm(user, PERMISSIONS.work_orders_complete);
  const isStaffUser = !!user && user.role !== "CUSTOMER";

  // ── List ──
  const [rows, setRows] = useState<WORow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("ALL");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<WORow[]>(`/api/v1/work-orders${qs({ pageSize: 200 })}`);
      setRows(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load work orders.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, reloadKey]);

  // ── Detail ──
  const [detail, setDetail] = useState<WODetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completeNote, setCompleteNote] = useState("");
  const [newItem, setNewItem] = useState("");
  const [matForm, setMatForm] = useState<WOMaterialForm>({ name: "", qty: "1", cost: "0" });
  const [labourHours, setLabourHours] = useState("0");
  const [labourRate, setLabourRate] = useState("0");

  const openDetail = useCallback(async (id: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    setCompleteNote("");
    setNewItem("");
    setMatForm({ name: "", qty: "1", cost: "0" });
    try {
      const res = await api.get<WODetail>(`/api/v1/work-orders/${id}`);
      setDetail(res.data);
      setLabourHours(String(res.data.labourHours ?? 0));
      setLabourRate(((res.data.labourRateCents ?? 0) / 100).toFixed(2));
    } catch (e) {
      toast({ title: "Could not load work order", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  }, [toast]);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const res = await api.get<WODetail>(`/api/v1/work-orders/${id}`);
      setDetail(res.data);
    } catch { /* detail refresh is best-effort */ }
  }, []);

  const afterMutation = useCallback(async () => {
    setReloadKey((k) => k + 1);
    if (detail) await refreshDetail(detail.id);
  }, [detail, refreshDetail]);

  const runTransition = useCallback(async (action: string, extra?: Record<string, unknown>) => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.post<WODetail>(`/api/v1/work-orders/${detail.id}/transition`, { action, ...extra });
      toast({ title: "Success", description: `Work order ${detail.code} — ${humanize(action)} done.` });
      if (action === "complete" || action === "cancel") {
        setDetailOpen(false);
        setDetail(null);
      } else {
        await refreshDetail(detail.id);
      }
      setReloadKey((k) => k + 1);
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [detail, refreshDetail, toast]);

  // ── Detail derived state ──
  const isAssignedTech = !!detail && !!user && detail.technician?.user?.id === user.id;
  const canOperate = !!detail && (isAssignedTech || canUpdate);
  const canExecute = !!detail && (isAssignedTech || canComplete);
  const woStatus = detail?.status;
  const woEditable = !!woStatus && !["COMPLETED", "CANCELLED"].includes(woStatus);
  const canEditLabour = woStatus === "IN_PROGRESS" && canOperate;
  const checklistDone = (detail?.checklist ?? []).filter((c) => c.done).length;

  async function toggleChecklist(item: ChecklistItem, done: boolean) {
    if (!detail) return;
    setBusy(true);
    try {
      await api.patch(`/api/v1/work-orders/${detail.id}/checklist`, { itemId: item.id, done });
      await refreshDetail(detail.id);
    } catch (e) {
      toast({ title: "Could not update checklist", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function addChecklistItem() {
    if (!detail || !newItem.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/work-orders/${detail.id}/checklist`, { label: newItem.trim() });
      setNewItem("");
      await refreshDetail(detail.id);
    } catch (e) {
      toast({ title: "Could not add item", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function addMaterial() {
    if (!detail) return;
    if (!matForm.name.trim()) {
      toast({ title: "Material name required", variant: "destructive" });
      return;
    }
    const qty = Number(matForm.qty);
    if (!isFinite(qty) || qty <= 0) {
      toast({ title: "Quantity must be greater than zero", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/v1/work-orders/${detail.id}/materials`, {
        name: matForm.name.trim(),
        quantity: qty,
        unitCostCents: toCents(matForm.cost || "0"),
      });
      setMatForm({ name: "", qty: "1", cost: "0" });
      await afterMutation();
    } catch (e) {
      toast({ title: "Could not add material", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function removeMaterial(materialId: string) {
    if (!detail) return;
    setBusy(true);
    try {
      await api.del(`/api/v1/work-orders/${detail.id}/materials${qs({ materialId })}`);
      await afterMutation();
    } catch (e) {
      toast({ title: "Could not remove material", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function saveLabour() {
    if (!detail) return;
    const hours = Number(labourHours);
    if (!isFinite(hours) || hours < 0) {
      toast({ title: "Invalid hours", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/api/v1/work-orders/${detail.id}`, { labourHours: hours, labourRateCents: toCents(labourRate || "0") });
      toast({ title: "Labour updated" });
      await afterMutation();
    } catch (e) {
      toast({ title: "Could not save labour", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // ── Create dialog ──
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [customers, setCustomers] = useState<CustomerOpt[]>([]);
  const [equipment, setEquipment] = useState<EquipmentOpt[]>([]);
  const [techs, setTechs] = useState<TechOpt[]>([]);
  const [openComplaints, setOpenComplaints] = useState<ComplaintOpt[]>([]);
  const draft = useDraft<WOCreateForm>({ formKey: "workorder.create", initial: EMPTY_CREATE });

  useEffect(() => {
    if (!createOpen || !canCreate) return;
    let alive = true;
    Promise.all([
      api.get<CustomerOpt[]>(`/api/v1/customers${qs({ pageSize: 200 })}`).catch(() => null),
      api.get<TechOpt[]>(`/api/v1/technicians${qs({ pageSize: 200 })}`).catch(() => null),
      api.get<ComplaintOpt[]>(`/api/v1/complaints${qs({ status: "IN_PROGRESS", pageSize: 200 })}`).catch(() => null),
    ]).then(([c, t, cmp]) => {
      if (!alive) return;
      setCustomers(c && Array.isArray(c.data) ? c.data : []);
      setTechs(t && Array.isArray(t.data) ? t.data : []);
      setOpenComplaints(cmp && Array.isArray(cmp.data) ? cmp.data : []);
    });
    return () => { alive = false; };
  }, [createOpen, canCreate]);

  useEffect(() => {
    if (!createOpen || !draft.value.customerId) { setEquipment([]); return; }
    let alive = true;
    api.get<EquipmentOpt[]>(`/api/v1/equipment${qs({ customerId: draft.value.customerId, pageSize: 200 })}`)
      .then((r) => { if (alive) setEquipment(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setEquipment([]); });
    return () => { alive = false; };
  }, [createOpen, draft.value.customerId]);

  function updateMaterialRow(index: number, patch: Partial<WOMaterialForm>) {
    draft.setValue({
      materials: draft.value.materials.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    });
  }

  async function submitCreate() {
    const v = draft.value;
    if (v.title.trim().length < 3) {
      toast({ title: "Check the form", description: "Title needs at least 3 characters.", variant: "destructive" });
      return;
    }
    if (!v.customerId) {
      toast({ title: "Check the form", description: "Select a customer.", variant: "destructive" });
      return;
    }
    const materials = v.materials
      .filter((m) => m.name.trim() && Number(m.qty) > 0)
      .map((m) => ({ name: m.name.trim(), quantity: Number(m.qty), unitCostCents: toCents(m.cost || "0") }));
    const checklist = v.checklistText.split("\n").map((s) => s.trim()).filter(Boolean);

    setSubmitting(true);
    try {
      const res = await api.post<WORow>("/api/v1/work-orders", {
        title: v.title.trim(),
        description: v.description.trim() || undefined,
        customerId: v.customerId,
        equipmentId: v.equipmentId || undefined,
        complaintId: v.complaintId || undefined,
        technicianId: v.technicianId || undefined,
        priority: v.priority,
        scheduledDate: v.scheduledDate || undefined,
        checklist,
        materials,
      });
      toast({ title: "Work order created", description: `${res.data.code} created successfully.` });
      draft.reset(EMPTY_CREATE);
      setCreateOpen(false);
      setReloadKey((k) => k + 1);
    } catch (e) {
      toast({ title: "Could not create work order", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  // ── Derived views ──
  const stats = useMemo(() => {
    const list = rows ?? [];
    const count = (match: (r: WORow) => boolean) => list.filter(match).length;
    return {
      total: list.length,
      pending: count((r) => PENDING_STATUSES.includes(r.status)),
      inProgress: count((r) => r.status === "IN_PROGRESS"),
      onHold: count((r) => r.status === "ON_HOLD"),
      completed: count((r) => r.status === "COMPLETED"),
      valueCents: list.filter((r) => !["CANCELLED"].includes(r.status)).reduce((s, r) => s + (r.totalCents ?? 0), 0),
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

  const columns: Column<WORow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, className: "font-mono text-xs whitespace-nowrap" },
    { key: "title", header: "Title", value: (r) => r.title, className: "max-w-[240px] truncate" },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} />, value: (r) => r.status },
    { key: "priority", header: "Priority", render: (r) => <PriorityBadge priority={r.priority} />, value: (r) => r.priority, hideOnMobile: true },
    { key: "customer", header: "Customer", value: (r) => r.customer?.companyName ?? "", hideOnMobile: true },
    { key: "technician", header: "Technician", value: (r) => r.technician?.user?.name ?? "", render: (r) => r.technician?.user?.name ?? "—" },
    { key: "scheduledDate", header: "Scheduled", value: (r) => r.scheduledDate ?? "", render: (r) => fmtDate(r.scheduledDate), hideOnMobile: true },
    { key: "totalCents", header: "Total", value: (r) => r.totalCents, render: (r) => money(r.totalCents), className: "tabular-nums whitespace-nowrap" },
  ];

  const complaintOptions = openComplaints.filter(
    (c) => !draft.value.customerId || c.customer?.id === draft.value.customerId
  );

  return (
    <div>
      <PageHeader
        title="Work Orders"
        subtitle="Execution cockpit: assignments, checklists, materials and costs."
        actions={canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> New Work Order
          </Button>
        ) : null}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <StatCard title="Total" value={stats.total} icon={<ClipboardList className="h-5 w-5" />} loading={!rows && loading} />
        <StatCard title="Pending" value={stats.pending} icon={<PlayCircle className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="In Progress" value={stats.inProgress} icon={<Wrench className="h-5 w-5" />} tone="warning" loading={!rows && loading} />
        <StatCard title="On Hold" value={stats.onHold} icon={<PauseCircle className="h-5 w-5" />} tone="danger" loading={!rows && loading} />
        <StatCard title="Completed" value={stats.completed} icon={<Hammer className="h-5 w-5" />} tone="success" loading={!rows && loading} />
        <StatCard title="Total Value" value={money(stats.valueCents)} icon={<CircleDollarSign className="h-5 w-5" />} loading={!rows && loading} />
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
        <LoadingState label="Loading work orders…" rows={5} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          title="No work orders in this view"
          hint={canCreate ? "Create a work order to dispatch a technician." : "Work orders will appear here when the team creates them."}
          action={canCreate ? <Button variant="outline" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> New Work Order</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={visibleRows}
          rowKey={(r) => r.id}
          onRowClick={(r) => openDetail(r.id)}
          searchPlaceholder="Search code or title…"
          filters={[{
            key: "priority",
            label: "Priorities",
            options: PRIORITIES.map((p) => ({ value: p, label: humanize(p) })),
            match: (row, value) => row.priority === value,
          }]}
          emptyTitle="No work orders match"
          exportName="work-orders"
        />
      )}

      {/* ── Detail dialog ── */}
      <Dialog open={detailOpen} onOpenChange={(open) => { if (!open) { setDetailOpen(false); setDetail(null); } }}>
        <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto hms-scroll">
          <DialogTitle className="sr-only">Work order details</DialogTitle>
          {detailLoading || !detail ? (
            <LoadingState label="Loading work order…" />
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
                  {detail.complaint ? ` · Complaint ${detail.complaint.code}` : ""}
                  {` · Created ${fmtDateTime(detail.createdAt)}`}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 sm:grid-cols-3 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Technician</p>
                  <p>{detail.technician?.user?.name ?? "Unassigned"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Scheduled</p>
                  <p>{fmtDate(detail.scheduledDate)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Started / Completed</p>
                  <p>{fmtDateTime(detail.startedAt)} → {fmtDateTime(detail.completedAt)}</p>
                </div>
              </div>

              {detail.description ? (
                <p className="text-sm whitespace-pre-wrap rounded-lg bg-muted/40 p-3">{detail.description}</p>
              ) : null}
              {detail.notes ? (
                <p className="text-sm whitespace-pre-wrap rounded-lg border border-dashed p-3"><span className="text-muted-foreground text-xs uppercase tracking-wide block mb-1">Notes</span>{detail.notes}</p>
              ) : null}

              {/* Totals */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Labour</p>
                  <p className="font-semibold tabular-nums">{money(detail.labourTotalCents)}</p>
                  <p className="text-xs text-muted-foreground">{detail.labourHours}h × {money(detail.labourRateCents)}/h</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Materials</p>
                  <p className="font-semibold tabular-nums">{money(detail.materialsTotalCents)}</p>
                  <p className="text-xs text-muted-foreground">{detail.materials.length} item{detail.materials.length === 1 ? "" : "s"}</p>
                </div>
                <div className="rounded-lg border p-3 bg-primary/5">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Total</p>
                  <p className="font-semibold tabular-nums text-primary">{money(detail.totalCents)}</p>
                </div>
              </div>

              {/* Checklist */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Checklist ({checklistDone}/{detail.checklist.length} done)</p>
                  {canOperate && woEditable ? (
                    <Badge variant="outline" className="text-[10px]">You can edit</Badge>
                  ) : null}
                </div>
                {detail.checklist.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No checklist items yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.checklist.map((item) => (
                      <li key={item.id} className="flex items-center gap-2.5 rounded-lg border p-2.5">
                        <Checkbox
                          checked={item.done}
                          disabled={busy || !canOperate || !woEditable}
                          onCheckedChange={(checked) => toggleChecklist(item, checked === true)}
                          aria-label={`Toggle ${item.label}`}
                        />
                        <span className={cn("text-sm flex-1", item.done && "line-through text-muted-foreground")}>{item.label}</span>
                        {item.doneAt ? <span className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtDateTime(item.doneAt)}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                {canOperate && woEditable ? (
                  <div className="flex gap-2">
                    <Input
                      value={newItem}
                      onChange={(e) => setNewItem(e.target.value)}
                      placeholder="Add checklist item…"
                      onKeyDown={(e) => { if (e.key === "Enter") addChecklistItem(); }}
                      maxLength={300}
                    />
                    <Button variant="outline" onClick={addChecklistItem} disabled={busy || !newItem.trim()}>
                      <Plus className="h-4 w-4 mr-1" /> Add
                    </Button>
                  </div>
                ) : null}
              </div>

              <Separator />

              {/* Materials */}
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Materials used</p>
                {detail.materials.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No materials recorded.</p>
                ) : (
                  <div className="rounded-lg border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="px-3 py-2 font-medium">Item</th>
                          <th className="px-3 py-2 font-medium text-right">Qty</th>
                          <th className="px-3 py-2 font-medium text-right">Unit cost</th>
                          <th className="px-3 py-2 font-medium text-right">Total</th>
                          {canOperate && woEditable ? <th className="px-3 py-2" /> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {detail.materials.map((m) => (
                          <tr key={m.id} className="border-b last:border-0">
                            <td className="px-3 py-2">
                              {m.name}
                              {m.inventoryItem ? <Badge variant="outline" className="ml-1.5 text-[10px]">stock</Badge> : null}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{m.quantity}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{money(m.unitCostCents)}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium">{money(m.totalCents)}</td>
                            {canOperate && woEditable ? (
                              <td className="px-3 py-2 text-right">
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeMaterial(m.id)} disabled={busy} aria-label={`Remove ${m.name}`}>
                                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                </Button>
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {canOperate && woEditable ? (
                  <div className="grid grid-cols-2 sm:grid-cols-[1fr_90px_120px_auto] gap-2">
                    <Input value={matForm.name} onChange={(e) => setMatForm((f) => ({ ...f, name: e.target.value }))} placeholder="Material name" maxLength={200} />
                    <Input value={matForm.qty} onChange={(e) => setMatForm((f) => ({ ...f, qty: e.target.value }))} placeholder="Qty" inputMode="decimal" />
                    <Input value={matForm.cost} onChange={(e) => setMatForm((f) => ({ ...f, cost: e.target.value }))} placeholder="Cost RM" inputMode="decimal" />
                    <Button variant="outline" onClick={addMaterial} disabled={busy}><Plus className="h-4 w-4 mr-1" /> Add</Button>
                  </div>
                ) : null}
              </div>

              <Separator />

              {/* Labour editor */}
              {canEditLabour ? (
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Labour (billable)</p>
                  <div className="grid grid-cols-2 sm:grid-cols-[120px_120px_auto] gap-2">
                    <div>
                      <Label htmlFor="wo-hours" className="text-xs">Hours</Label>
                      <Input id="wo-hours" value={labourHours} onChange={(e) => setLabourHours(e.target.value)} inputMode="decimal" />
                    </div>
                    <div>
                      <Label htmlFor="wo-rate" className="text-xs">Rate (RM/h)</Label>
                      <Input id="wo-rate" value={labourRate} onChange={(e) => setLabourRate(e.target.value)} inputMode="decimal" />
                    </div>
                    <div className="flex items-end">
                      <Button variant="outline" onClick={saveLabour} disabled={busy}>Save Labour</Button>
                    </div>
                  </div>
                </div>
              ) : null}

              <Separator />

              {/* Transitions */}
              <div className="space-y-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Workflow actions</p>

                {woStatus === "PENDING" && (isAssignedTech || canUpdate) ? (
                  <Button disabled={busy} onClick={() => runTransition("accept")}>
                    <PlayCircle className="h-4 w-4 mr-1.5" /> Accept
                  </Button>
                ) : null}

                {woStatus === "ACCEPTED" && (isAssignedTech || canUpdate) ? (
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => runTransition("start")}>
                      <Wrench className="h-4 w-4 mr-1.5" /> Start Work
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => runTransition("hold")}>
                      <PauseCircle className="h-4 w-4 mr-1.5" /> Put On Hold
                    </Button>
                  </div>
                ) : null}

                {woStatus === "IN_PROGRESS" && (isAssignedTech || canUpdate) ? (
                  <Button variant="outline" disabled={busy} onClick={() => runTransition("hold")}>
                    <PauseCircle className="h-4 w-4 mr-1.5" /> Put On Hold
                  </Button>
                ) : null}

                {woStatus === "ON_HOLD" && (isAssignedTech || canUpdate) ? (
                  <Button disabled={busy} onClick={() => runTransition("resume")}>
                    <PlayCircle className="h-4 w-4 mr-1.5" /> Resume Work
                  </Button>
                ) : null}

                {woStatus === "IN_PROGRESS" && (isAssignedTech || canComplete) ? (
                  <div className="rounded-lg border p-3 space-y-2">
                    <Label htmlFor="wo-complete-note" className="text-xs uppercase tracking-wide text-muted-foreground">Completion note</Label>
                    {checklistDone < detail.checklist.length ? (
                      <p className="text-xs text-amber-600">Heads-up: only {checklistDone}/{detail.checklist.length} checklist items are done.</p>
                    ) : null}
                    <Textarea id="wo-complete-note" value={completeNote} onChange={(e) => setCompleteNote(e.target.value)} placeholder="Summary of work performed…" rows={2} />
                    <Button disabled={busy} onClick={() => runTransition("complete", { note: completeNote || undefined })}>
                      <Hammer className="h-4 w-4 mr-1.5" /> Mark Completed
                    </Button>
                  </div>
                ) : null}

                {woStatus && ["PENDING", "ACCEPTED", "ON_HOLD"].includes(woStatus) && (isAssignedTech || canAssign) ? (
                  <div className="rounded-lg border border-destructive/30 p-3">
                    <p className="text-sm mb-2 text-muted-foreground">Cancelling stops this work order permanently.</p>
                    <Button variant="destructive" disabled={busy} onClick={() => { if (window.confirm(`Cancel work order ${detail.code}? This cannot be undone.`)) runTransition("cancel"); }}>
                      Cancel Work Order
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
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto hms-scroll">
          <DialogHeader>
            <DialogTitle>New Work Order</DialogTitle>
            <DialogDescription>
              Dispatch a job to a technician. Checklist lines and materials can also be added later.
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
              <Label htmlFor="wo-title">Title *</Label>
              <Input id="wo-title" value={draft.value.title} onChange={(e) => draft.setValue({ title: e.target.value })} placeholder="What needs to be done" maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wo-desc">Description</Label>
              <Textarea id="wo-desc" value={draft.value.description} onChange={(e) => draft.setValue({ description: e.target.value })} placeholder="Scope, access notes, safety requirements…" rows={3} maxLength={5000} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Customer *</Label>
                <Select value={draft.value.customerId} onValueChange={(v) => draft.setValue({ customerId: v, equipmentId: "", complaintId: "" })}>
                  <SelectTrigger aria-label="Customer"><SelectValue placeholder="Select customer…" /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.companyName ?? c.name ?? c.id}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Equipment</Label>
                <Select value={draft.value.equipmentId} onValueChange={(v) => draft.setValue({ equipmentId: v })}>
                  <SelectTrigger aria-label="Equipment">
                    <SelectValue placeholder={draft.value.customerId ? (equipment.length ? "Optional…" : "No equipment available") : "Select a customer first…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {equipment.map((e) => <SelectItem key={e.id} value={e.id}>{e.name ?? e.id}{e.assetTag ? ` (${e.assetTag})` : ""}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Linked complaint</Label>
                <Select value={draft.value.complaintId} onValueChange={(v) => draft.setValue({ complaintId: v })}>
                  <SelectTrigger aria-label="Complaint">
                    <SelectValue placeholder={openComplaints.length ? "Optional — link an open complaint…" : "No in-progress complaints"} />
                  </SelectTrigger>
                  <SelectContent>
                    {complaintOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.code} — {c.title}{c.customer?.companyName ? ` (${c.customer.companyName})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Technician</Label>
                <Select value={draft.value.technicianId} onValueChange={(v) => draft.setValue({ technicianId: v })}>
                  <SelectTrigger aria-label="Technician">
                    <SelectValue placeholder={techs.length ? "Optional — assign now…" : "No technicians available"} />
                  </SelectTrigger>
                  <SelectContent>
                    {techs.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.user?.name ?? t.employeeNo ?? t.id}{t.specialty ? ` — ${humanize(t.specialty)}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
              <div className="space-y-1.5">
                <Label htmlFor="wo-scheduled">Scheduled date</Label>
                <Input id="wo-scheduled" type="date" value={draft.value.scheduledDate} onChange={(e) => draft.setValue({ scheduledDate: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wo-checklist">Checklist — one item per line</Label>
              <Textarea
                id="wo-checklist"
                value={draft.value.checklistText}
                onChange={(e) => draft.setValue({ checklistText: e.target.value })}
                placeholder={"Isolate & secure work area\nDiagnose fault\nFunction test"}
                rows={3}
              />
            </div>

            {/* Materials rows */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Materials</Label>
                <Button
                  type="button" size="sm" variant="outline"
                  onClick={() => draft.setValue({ materials: [...draft.value.materials, { name: "", qty: "1", cost: "0" }] })}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add row
                </Button>
              </div>
              {draft.value.materials.length === 0 ? (
                <p className="text-xs text-muted-foreground">No materials yet — add rows for parts that will be consumed (cost in RM).</p>
              ) : (
                <div className="space-y-2">
                  {draft.value.materials.map((m, i) => (
                    <div key={i} className="grid grid-cols-[1fr_80px_110px_40px] gap-2 items-center">
                      <Input value={m.name} onChange={(e) => updateMaterialRow(i, { name: e.target.value })} placeholder="Material name" maxLength={200} aria-label="Material name" />
                      <Input value={m.qty} onChange={(e) => updateMaterialRow(i, { qty: e.target.value })} placeholder="Qty" inputMode="decimal" aria-label="Quantity" />
                      <Input value={m.cost} onChange={(e) => updateMaterialRow(i, { cost: e.target.value })} placeholder="RM" inputMode="decimal" aria-label="Unit cost in ringgit" />
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => draft.setValue({ materials: draft.value.materials.filter((_, j) => j !== i) })} aria-label="Remove material row">
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Estimated materials total: <span className="tabular-nums">{money(draft.value.materials.reduce((s, m) => s + (Number(m.qty) > 0 ? Math.round(Number(m.qty) * toCents(m.cost || "0")) : 0), 0))}</span>
                  </p>
                </div>
              )}
            </div>
            {draft.dirty ? <p className="text-xs text-muted-foreground">Draft auto-saves as you type — safe to leave and restore later.</p> : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>Cancel</Button>
            <Button onClick={submitCreate} disabled={submitting || draft.value.title.trim().length < 3 || !draft.value.customerId}>
              {submitting ? "Creating…" : "Create Work Order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
