"use client";

// MOHD.HMS ENTERPRISE — Equipment module (list page).
// Asset register with QR labels (scan-to-open deep link) and maintenance
// history on the asset's dedicated detail page.
//
// NAVIGATION ARCHITECTURE: register / detail / edit / label are DEDICATED
// PAGES routed by the hash router (ui-store pages["equipment"]):
//   []                    → this list page
//   ["new"]               → EquipmentNewPage
//   [id]                  → EquipmentDetailPage (history)
//   [id, "edit"]          → EquipmentEditPage
//   [id, "label"]         → EquipmentLabelPage (QR)
// Retire is a confirmation AlertDialog (kept on the list rows AND the detail page).

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, ErrorState, DrilldownChips } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { useModuleQuery } from "@/lib/hms/page-query";
import { fmtDate } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Archive, CalendarClock, FileText, Package, Pencil, Plus, QrCode, Wrench } from "lucide-react";
import { EquipmentNewPage } from "./new-page";
import { EquipmentDetailPage } from "./detail-page";
import { EquipmentEditPage } from "./edit-page";
import { EquipmentLabelPage } from "./label-page";
import { CATEGORIES, type EquipmentRow } from "./shared";

// ── Module router ──

/**
 * Consumes a pending QR deep link (shell stores it from /?resource=equipment:{token})
 * and resolves the token to the unit's dedicated detail page — so a scan opens
 * the exact asset, not just the register. Subscribes to the store so links set
 * while the module is already mounted (QR dialog paste) also resolve; failures
 * keep the user on the register with an explanatory toast.
 */
function EquipmentDeepLinkResolver() {
  const { toast } = useToast();
  // Subscribe so a link set while the module is ALREADY mounted (e.g. pasted
  // into the QR dialog from a detail page) still triggers resolution.
  const deepLink = useUi((s) => s.deepLink);
  useEffect(() => {
    if (!deepLink || deepLink.type !== "equipment" || !deepLink.token) return;
    const token = deepLink.token;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ equipmentId: string; assetTag: string; name: string }>(
          `/api/v1/equipment/-/qr?token=${encodeURIComponent(token)}`
        );
        if (cancelled || !res.data?.equipmentId) return;
        // Clear the link only after resolution so the in-flight effect is not
        // cancelled by its own state update (consume → re-render → cleanup).
        useUi.getState().consumeDeepLink();
        toast({ title: "Equipment found", description: `${res.data.assetTag} — ${res.data.name}` });
        navigateTo("equipment", [res.data.equipmentId]);
      } catch (e) {
        if (!cancelled) {
          useUi.getState().consumeDeepLink();
          toast({
            title: "Scan could not be resolved",
            description: e instanceof Error ? e.message : "This equipment token is unknown.",
            variant: "destructive",
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [deepLink, toast]);
  return null;
}

export function EquipmentModule() {
  const seg = useUi((s) => s.pages["equipment"]) ?? [];
  const query = useUi((s) => s.queries["equipment"] ?? "");
  const page = pageFromSeg(seg);

  const content = (() => {
    if (page.view === "new") return <EquipmentNewPage />;
    if (page.view === "detail" && page.id) return <EquipmentDetailPage id={page.id} />;
    if (page.view === "edit" && page.id) return <EquipmentEditPage id={page.id} />;
    if (page.view === "label" && page.id) return <EquipmentLabelPage id={page.id} />;
    // key={query}: a new drill-down URL (KPI click / direct link) remounts the
    // list with the query applied as its initial filter state.
    return <EquipmentList key={query} />;
  })();

  return (
    <>
      <EquipmentDeepLinkResolver />
      {content}
    </>
  );
}

// ── List page ──

function EquipmentList() {
  const { user } = useSession();
  const { toast } = useToast();
  const canCreate = hasPerm(user, PERMISSIONS.equipment_create);
  const canUpdate = hasPerm(user, PERMISSIONS.equipment_update);
  const canDelete = hasPerm(user, PERMISSIONS.equipment_delete);

  // KPI drill-down (e.g. #/equipment?status=UNDER_MAINTENANCE): validated
  // against the table's filter option values, then applied once on mount.
  const dq = useModuleQuery("equipment");
  const STATUS_VALUES = ["ACTIVE", "UNDER_MAINTENANCE", "RETIRED"];
  const statusParam = STATUS_VALUES.find((s) => s === dq.params.status?.toUpperCase());
  const initialFilters = statusParam ? { status: statusParam } : undefined;

  const [rows, setRows] = useState<EquipmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Retire confirm (AlertDialog stays per architecture)
  const [retireRow, setRetireRow] = useState<EquipmentRow | null>(null);
  const [retiring, setRetiring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<EquipmentRow[]>(`/api/v1/equipment${qs({ pageSize: 200 })}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submitRetire() {
    if (!retireRow) return;
    setRetiring(true);
    try {
      await api.del(`/api/v1/equipment/${retireRow.id}`);
      toast({ title: "Equipment retired", description: `${retireRow.assetTag} is now RETIRED — its maintenance history is preserved.` });
      setRetireRow(null);
      load();
    } catch (e) {
      toast({ title: "Could not retire equipment", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setRetiring(false);
    }
  }

  const activeCount = rows.filter((r) => r.status === "ACTIVE").length;
  const maintenanceCount = rows.filter((r) => r.status === "UNDER_MAINTENANCE").length;
  const warrantySoon = rows.filter((r) => r.warrantyExpiry && new Date(r.warrantyExpiry).getTime() - Date.now() < 90 * 86400000 && new Date(r.warrantyExpiry).getTime() > Date.now()).length;

  const columns: Column<EquipmentRow>[] = [
    { key: "assetTag", header: "Asset tag", value: (r) => r.assetTag, className: "font-mono text-xs whitespace-nowrap" },
    {
      key: "name", header: "Equipment", value: (r) => r.name,
      render: (r) => (
        <div className="min-w-[150px]">
          <div className="font-medium truncate">{r.name}</div>
          <div className="text-xs text-muted-foreground truncate">{[r.manufacturer, r.model].filter(Boolean).join(" ") || r.serialNumber || "—"}</div>
        </div>
      ),
    },
    { key: "category", header: "Category", value: (r) => r.category, render: (r) => <span className="text-xs">{r.category.replace(/_/g, " ")}</span>, hideOnMobile: true },
    {
      key: "customer", header: "Customer", value: (r) => r.customer?.companyName ?? "",
      render: (r) => <span className="text-sm truncate block max-w-[160px]">{r.customer?.companyName ?? "—"}</span>,
    },
    {
      key: "location", header: "Location", value: (r) => r.location?.name ?? "",
      render: (r) => r.location?.name ?? "—",
      hideOnMobile: true,
    },
    {
      key: "warrantyExpiry", header: "Warranty", value: (r) => r.warrantyExpiry ?? "",
      render: (r) => {
        if (!r.warrantyExpiry) return <span className="text-muted-foreground text-sm">—</span>;
        const expired = new Date(r.warrantyExpiry).getTime() < Date.now();
        return <span className={`text-xs whitespace-nowrap ${expired ? "text-red-600" : ""}`}>{fmtDate(r.warrantyExpiry)}</span>;
      },
      hideOnMobile: true,
    },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "actions", header: "", sortable: false,
      render: (r) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigateTo("equipment", [r.id, "label"])} aria-label={`QR label for ${r.assetTag}`}>
            <QrCode className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigateTo("equipment", [r.id])} aria-label={`History for ${r.assetTag}`}>
            <FileText className="h-4 w-4" />
          </Button>
          {canUpdate && r.status !== "RETIRED" ? (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigateTo("equipment", [r.id, "edit"])} aria-label={`Edit ${r.assetTag}`}>
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
          {canDelete && r.status !== "RETIRED" ? (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setRetireRow(r)} aria-label={`Retire ${r.assetTag}`}>
              <Archive className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ),
      className: "w-4",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Equipment"
        subtitle="Asset register with QR scan-to-open labels"
        actions={
          canCreate ? (
            <Button onClick={() => navigateTo("equipment", ["new"])}>
              <Plus className="h-4 w-4 mr-1.5" /> New Equipment
            </Button>
          ) : null
        }
      />

      <DrilldownChips
        chips={statusParam ? [{ key: "status", label: "Status", value: statusParam === "UNDER_MAINTENANCE" ? "Under maintenance" : humanize(statusParam) }] : []}
        onRemove={(key) => dq.apply({ [key]: undefined })}
        onClear={dq.clear}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard title="Units" value={rows.length} icon={<Package className="h-5 w-5" />} loading={loading} />
        <StatCard title="Active" value={activeCount} tone="success" loading={loading} />
        <StatCard title="Under maintenance" value={maintenanceCount} tone={maintenanceCount ? "warning" : "success"} icon={<Wrench className="h-5 w-5" />} loading={loading} />
        <StatCard title="Warranty < 90 days" value={warrantySoon} tone={warrantySoon ? "warning" : "success"} icon={<CalendarClock className="h-5 w-5" />} loading={loading} />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <LoadingState label="Loading equipment…" />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          initialFilters={initialFilters}
          onRowClick={(r) => navigateTo("equipment", [r.id])}
          searchPlaceholder="Search tag, name, serial, manufacturer…"
          filters={[
            {
              key: "status", label: "Status",
              options: [
                { value: "ACTIVE", label: "Active" },
                { value: "UNDER_MAINTENANCE", label: "Under maintenance" },
                { value: "RETIRED", label: "Retired" },
              ],
              match: (r, v) => r.status === v,
            },
            {
              key: "category", label: "Category",
              options: CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, " ") })),
              match: (r, v) => r.category === v,
            },
          ]}
          emptyTitle="No equipment registered"
          emptyHint="Register your first asset to generate its QR label."
          exportName="equipment"
        />
      )}

      {/* Retire confirmation — AlertDialog kept per architecture (confirm-only) */}
      <AlertDialog open={!!retireRow} onOpenChange={(o) => !o && setRetireRow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {retireRow?.assetTag}?</AlertDialogTitle>
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
    </div>
  );
}
