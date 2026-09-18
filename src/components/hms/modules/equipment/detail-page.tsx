"use client";

// MOHD.HMS ENTERPRISE — Equipment Detail (dedicated full page).
// Replaces the former detail/history dialog: same data (GET /api/v1/equipment/{id}
// incl. maintenance history), same attribute grid, same 4 history lists — no popup.
// Complaints and work-order history rows link to their dedicated detail pages;
// PM tasks and inspections render as plain rows (no detail routes — no invented links).
// Retire stays an AlertDialog (confirmation-only per architecture).

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Archive, CalendarClock, FileText, Pencil, QrCode, SearchCheck, Wrench,
} from "lucide-react";
import { HistorySection, type EquipmentDetail, type HistoryItem } from "./shared";
import { PdfButtons } from "@/components/hms/shared/pdf-buttons";

export function EquipmentDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canUpdate = hasPerm(user, PERMISSIONS.equipment_update);
  const canDelete = hasPerm(user, PERMISSIONS.equipment_delete);

  const [detail, setDetail] = useState<EquipmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [retiring, setRetiring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<EquipmentDetail>(`/api/v1/equipment/${id}`);
      setDetail(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this equipment.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function submitRetire() {
    if (!detail) return;
    setRetiring(true);
    try {
      await api.del(`/api/v1/equipment/${detail.id}`);
      toast({ title: "Equipment retired", description: `${detail.assetTag} is now RETIRED — its maintenance history is preserved.` });
      setConfirmRetire(false);
      await load(); // refresh the authoritative record (status → RETIRED)
    } catch (e) {
      toast({ title: "Could not retire equipment", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setRetiring(false);
    }
  }

  if (loading && !detail) {
    return (
      <PageShell backLabel="Back to Equipment" backHref="#/equipment" title="Equipment details">
        <LoadingState label="Loading equipment…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !detail) {
    return (
      <PageShell backLabel="Back to Equipment" backHref="#/equipment" title="Equipment details">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!detail) {
    return (
      <PageShell backLabel="Back to Equipment" backHref="#/equipment" title="Equipment details">
        <EmptyState title="Equipment not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  // History rows: complaints and work orders have dedicated detail pages → link.
  const complaints: HistoryItem[] = detail.history.complaints.map((c) => ({
    id: c.id, code: c.code, primary: c.title, badge: c.status,
    secondary: fmtDate(c.createdAt), badge2: c.priority, href: `#/complaints/${encodeURIComponent(c.id)}`,
  }));
  const workOrders: HistoryItem[] = detail.history.workOrders.map((w) => ({
    id: w.id, code: w.code, primary: w.title, badge: w.status,
    secondary: fmtDate(w.createdAt), badge2: w.priority, href: `#/work-orders/${encodeURIComponent(w.id)}`,
  }));
  const pmTasks: HistoryItem[] = detail.history.pmTasks.map((p) => ({
    id: p.id, code: p.code, primary: `Due ${fmtDate(p.dueDate)}`, badge: p.status,
    secondary: p.completedAt ? `Done ${fmtDate(p.completedAt)}` : "Not completed",
  }));
  const inspections: HistoryItem[] = detail.history.inspections.map((i) => ({
    id: i.id, code: i.code, primary: i.title, badge: i.status,
    secondary: fmtDate(i.inspectionDate), badge2: i.overallCondition,
  }));

  const canEdit = canUpdate && detail.status !== "RETIRED";
  const canRetire = canDelete && detail.status !== "RETIRED";

  return (
    <PageShell
      backLabel="Back to Equipment"
      backHref="#/equipment"
      crumbs={[{ label: "Equipment", href: "#/equipment" }, { label: detail.assetTag }]}
      title={detail.name}
      description={`${detail.assetTag} · ${[detail.manufacturer, detail.model].filter(Boolean).join(" ") || "No model info"}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={detail.status} />
          {canEdit ? (
            <Button variant="outline" onClick={() => navigateTo("equipment", [detail.id, "edit"])}>
              <Pencil className="h-4 w-4 mr-1.5" /> Edit
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => navigateTo("equipment", [detail.id, "label"])}>
            <QrCode className="h-4 w-4 mr-1.5" /> QR Label
          </Button>
          <PdfButtons type="equipment-report" id={detail.id} label={`Equipment report ${detail.assetTag}`} />
          {canRetire ? (
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmRetire(true)}>
              <Archive className="h-4 w-4 mr-1.5" /> Retire
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        {/* Attribute grid */}
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div><p className="text-xs text-muted-foreground">Customer</p><p className="truncate">{detail.customer?.companyName ?? "—"}</p></div>
            <div><p className="text-xs text-muted-foreground">Location</p><p className="truncate">{detail.location?.name ?? "—"}</p></div>
            <div><p className="text-xs text-muted-foreground">Installed</p><p>{fmtDate(detail.installationDate)}</p></div>
            <div><p className="text-xs text-muted-foreground">Warranty</p><p>{fmtDate(detail.warrantyExpiry)}</p></div>
            <div><p className="text-xs text-muted-foreground">Serial</p><p className="font-mono text-xs pt-0.5 truncate">{detail.serialNumber || "—"}</p></div>
            <div><p className="text-xs text-muted-foreground">Category</p><p>{detail.category.replace(/_/g, " ")}</p></div>
            <div><p className="text-xs text-muted-foreground">PM cycle</p><p>{detail.pmFrequencyDays} days</p></div>
            <div><p className="text-xs text-muted-foreground">QR token</p><p className="font-mono text-[10px] pt-1 truncate">{detail.qrToken}</p></div>
          </div>

          {detail.notes ? (
            <div className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <p className="text-xs text-muted-foreground mb-1">Notes</p>
              {detail.notes}
            </div>
          ) : null}
        </div>

        {/* Maintenance history (former dialog sections, moved 1:1) */}
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-5">
          <HistorySection icon={<FileText className="h-3.5 w-3.5" />} title="Complaints" empty="No complaints on this unit." items={complaints} />
          <HistorySection icon={<Wrench className="h-3.5 w-3.5" />} title="Work orders" empty="No work orders yet." items={workOrders} />
          <HistorySection icon={<CalendarClock className="h-3.5 w-3.5" />} title="PM tasks" empty="No preventive maintenance scheduled." items={pmTasks} />
          <HistorySection icon={<SearchCheck className="h-3.5 w-3.5" />} title="Inspections" empty="No inspection reports linked." items={inspections} />
        </div>
      </div>

      {/* Retire confirmation — AlertDialog kept per architecture (confirm-only) */}
      <AlertDialog open={confirmRetire} onOpenChange={setConfirmRetire}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {detail.assetTag}?</AlertDialogTitle>
            <AlertDialogDescription>
              The unit is marked RETIRED, never deleted — complaints, work orders and PM history stay attached for audit and finance.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={retiring} onClick={(e) => { e.preventDefault(); submitRetire(); }}>
              {retiring ? "Working…" : "Retire equipment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
