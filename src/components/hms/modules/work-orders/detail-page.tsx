"use client";

// MOHD.HMS ENTERPRISE — Work Order Detail (dedicated full page).
// Replaces the former detail dialog: same data, same embedded editors, same
// APIs — no popup. Checklist / materials / labour editors stay INLINE on the
// page; cancel confirmation is the only dialog (AlertDialog).

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { PageShell } from "@/components/hms/shared/page-shell";
import { PriorityBadge, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { WorkflowTimeline } from "@/components/hms/shared/workflow-timeline";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { money, fmtDate, fmtDateTime, toCents } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CircleDollarSign, Hammer, PauseCircle, PlayCircle, Plus, Trash2, Wrench,
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

type WOMaterialForm = { name: string; qty: string; cost: string };

// ── Page ──

export function WorkOrderDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();

  const canUpdate = hasPerm(user, PERMISSIONS.work_orders_update);
  const canAssign = hasPerm(user, PERMISSIONS.work_orders_assign);
  const canComplete = hasPerm(user, PERMISSIONS.work_orders_complete);

  const [detail, setDetail] = useState<WODetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Embedded editors (formerly dialog-local state — now page state).
  const [completeNote, setCompleteNote] = useState("");
  const [newItem, setNewItem] = useState("");
  const [matForm, setMatForm] = useState<WOMaterialForm>({ name: "", qty: "1", cost: "0" });
  const [labourHours, setLabourHours] = useState("0");
  const [labourRate, setLabourRate] = useState("0");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<WODetail>(`/api/v1/work-orders/${id}`);
      setDetail(res.data);
      setLabourHours(String(res.data.labourHours ?? 0));
      setLabourRate(((res.data.labourRateCents ?? 0) / 100).toFixed(2));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this work order.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const refreshDetail = useCallback(async () => {
    try {
      const res = await api.get<WODetail>(`/api/v1/work-orders/${id}`);
      setDetail(res.data);
      setLabourHours(String(res.data.labourHours ?? 0));
      setLabourRate(((res.data.labourRateCents ?? 0) / 100).toFixed(2));
    } catch { /* detail refresh is best-effort */ }
  }, [id]);

  const runTransition = useCallback(async (action: string, extra?: Record<string, unknown>) => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.post<WODetail>(`/api/v1/work-orders/${detail.id}/transition`, { action, ...extra });
      toast({ title: "Success", description: `Work order ${detail.code} — ${humanize(action)} done.` });
      // Stay on the detail page — refresh with the authoritative server record.
      await refreshDetail();
      setCompleteNote("");
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [detail, refreshDetail, toast]);

  async function toggleChecklist(item: ChecklistItem, done: boolean) {
    if (!detail) return;
    setBusy(true);
    try {
      await api.patch(`/api/v1/work-orders/${detail.id}/checklist`, { itemId: item.id, done });
      await refreshDetail();
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
      await refreshDetail();
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
      await refreshDetail();
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
      await refreshDetail();
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
      await refreshDetail();
    } catch (e) {
      toast({ title: "Could not save labour", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // ── Derived state (same rules as before) ──
  const isAssignedTech = !!detail && !!user && detail.technician?.user?.id === user.id;
  const canOperate = !!detail && (isAssignedTech || canUpdate);
  const woStatus = detail?.status;
  const woEditable = !!woStatus && !["COMPLETED", "CANCELLED"].includes(woStatus);
  const canEditLabour = woStatus === "IN_PROGRESS" && canOperate;
  const checklistDone = (detail?.checklist ?? []).filter((c) => c.done).length;

  if (loading && !detail) {
    return (
      <PageShell backLabel="Back to Work Orders" backHref="#/work-orders" title="Work order details">
        <LoadingState label="Loading work order…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !detail) {
    return (
      <PageShell backLabel="Back to Work Orders" backHref="#/work-orders" title="Work order details">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!detail) {
    return (
      <PageShell backLabel="Back to Work Orders" backHref="#/work-orders" title="Work order details">
        <EmptyState title="Work order not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Work Orders"
      backHref="#/work-orders"
      crumbs={[{ label: "Work Orders", href: "#/work-orders" }, { label: detail.code }]}
      title={detail.title}
      description={`${detail.customer?.companyName ?? "—"}${detail.equipment ? ` · ${detail.equipment.name} (${detail.equipment.assetTag})` : ""} · Created ${fmtDateTime(detail.createdAt)}`}
      actions={
        <div className="flex items-center gap-2">
          <StatusBadge status={detail.status} />
          <PriorityBadge priority={detail.priority} />
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Main column ── */}
        <div className="lg:col-span-2 space-y-4">
          {/* Main info */}
          <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-mono text-muted-foreground">{detail.code}</span>
              {detail.complaint ? (
                <a
                  href={`#/complaints/${encodeURIComponent(detail.complaint.id)}`}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2"
                >
                  Complaint {detail.complaint.code}
                </a>
              ) : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-3 text-sm">
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Technician</p>
                <p>{detail.technician?.user?.name ?? "Unassigned"}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Scheduled</p>
                <p>{fmtDate(detail.scheduledDate)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Started / Completed</p>
                <p>{fmtDateTime(detail.startedAt)} → {fmtDateTime(detail.completedAt)}</p>
              </div>
            </div>
            {detail.description ? (
              <div className="text-sm space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Description</p>
                <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3">{detail.description}</p>
              </div>
            ) : null}
            {detail.notes ? (
              <div className="text-sm space-y-1">
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Notes</p>
                <p className="whitespace-pre-wrap rounded-lg border border-dashed p-3">{detail.notes}</p>
              </div>
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
          </div>

          {/* Checklist */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between gap-2">
                <span>Checklist ({checklistDone}/{detail.checklist.length} done)</span>
                {canOperate && woEditable ? (
                  <Badge variant="outline" className="text-[10px]">You can edit</Badge>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
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
                <div className="flex gap-2 pt-1">
                  <Input
                    value={newItem}
                    onChange={(e) => setNewItem(e.target.value)}
                    placeholder="Add checklist item…"
                    onKeyDown={(e) => { if (e.key === "Enter") addChecklistItem(); }}
                    maxLength={300}
                    aria-label="New checklist item"
                  />
                  <Button variant="outline" onClick={addChecklistItem} disabled={busy || !newItem.trim()}>
                    <Plus className="h-4 w-4 mr-1" /> Add
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Materials */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Materials used</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
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
                  <Input value={matForm.name} onChange={(e) => setMatForm((f) => ({ ...f, name: e.target.value }))} placeholder="Material name" maxLength={200} aria-label="Material name" />
                  <Input value={matForm.qty} onChange={(e) => setMatForm((f) => ({ ...f, qty: e.target.value }))} placeholder="Qty" inputMode="decimal" aria-label="Quantity" />
                  <Input value={matForm.cost} onChange={(e) => setMatForm((f) => ({ ...f, cost: e.target.value }))} placeholder="Cost RM" inputMode="decimal" aria-label="Unit cost in ringgit" />
                  <Button variant="outline" onClick={addMaterial} disabled={busy}><Plus className="h-4 w-4 mr-1" /> Add</Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Labour editor */}
          {canEditLabour ? (
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Labour (billable)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-[120px_120px_auto] gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="wo-hours" className="text-xs">Hours</Label>
                    <Input id="wo-hours" value={labourHours} onChange={(e) => setLabourHours(e.target.value)} inputMode="decimal" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wo-rate" className="text-xs">Rate (RM/h)</Label>
                    <Input id="wo-rate" value={labourRate} onChange={(e) => setLabourRate(e.target.value)} inputMode="decimal" />
                  </div>
                  <div className="flex items-end">
                    <Button variant="outline" onClick={saveLabour} disabled={busy}>Save Labour</Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* ── Workflow action column ── */}
        <div className="space-y-3">
          <div className="rounded-xl border bg-card shadow-sm p-4 space-y-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Workflow actions</p>

            {woStatus === "PENDING" && (isAssignedTech || canUpdate) ? (
              <Button disabled={busy} onClick={() => runTransition("accept")} className="w-full">
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
              <Button variant="outline" disabled={busy} onClick={() => runTransition("hold")} className="w-full">
                <PauseCircle className="h-4 w-4 mr-1.5" /> Put On Hold
              </Button>
            ) : null}

            {woStatus === "ON_HOLD" && (isAssignedTech || canUpdate) ? (
              <Button disabled={busy} onClick={() => runTransition("resume")} className="w-full">
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
                <Button disabled={busy} onClick={() => runTransition("complete", { note: completeNote || undefined })} className="w-full">
                  <Hammer className="h-4 w-4 mr-1.5" /> Mark Completed
                </Button>
              </div>
            ) : null}

            {woStatus && ["PENDING", "ACCEPTED", "ON_HOLD"].includes(woStatus) && (isAssignedTech || canAssign) ? (
              <div className="rounded-lg border border-destructive/30 p-3">
                <p className="text-sm mb-2 text-muted-foreground">Cancelling stops this work order permanently.</p>
                <Button variant="destructive" disabled={busy} onClick={() => setConfirmCancel(true)} className="w-full">
                  Cancel Work Order
                </Button>
              </div>
            ) : null}

            {!(woStatus && ["PENDING", "ACCEPTED", "IN_PROGRESS", "ON_HOLD"].includes(woStatus) && (isAssignedTech || canUpdate || canComplete || canAssign)) ? (
              <p className="text-sm text-muted-foreground">
                {woStatus === "COMPLETED"
                  ? "This work order is completed — record is read-only."
                  : woStatus === "CANCELLED"
                    ? "This work order was cancelled — record is read-only."
                    : "No workflow actions available for your role."}
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border bg-card shadow-sm p-4 text-sm space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Cost summary</p>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total value</span>
              <span className="font-semibold tabular-nums inline-flex items-center gap-1.5">
                <CircleDollarSign className="h-4 w-4 text-primary" aria-hidden /> {money(detail.totalCents)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Labour and materials feed the customer invoice once the work order is completed.</p>
          </div>
        </div>
      </div>

      <WorkflowTimeline resourceType="WORK_ORDER" resourceId={detail.id} className="mt-6" />

      {/* Cancel confirmation — the only dialog kept on this page */}
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel work order {detail.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => runTransition("cancel")}
            >
              Cancel work order
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
