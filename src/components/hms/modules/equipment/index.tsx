"use client";

// MOHD.HMS ENTERPRISE — Equipment module.
// Asset register with QR labels (scan-to-open deep link), maintenance history
// detail, draft-protected creation and retirement that keeps history intact.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import type { Permission } from "@/lib/hms/constants";
import { fmtDate } from "@/lib/hms/format";
import { FileText, Package, Printer, QrCode, Download, Pencil, Plus, RotateCcw, Archive, Wrench, CalendarClock, SearchCheck } from "lucide-react";

type EquipmentRow = {
  id: string; assetTag: string; name: string; serialNumber: string;
  manufacturer: string; model: string; category: string; status: string;
  installationDate: string | null; warrantyExpiry: string | null;
  pmFrequencyDays: number; qrToken: string; notes: string; createdAt: string;
  customerId: string | null;
  location: { id: string; name: string; code: string } | null;
  customer: { id: string; companyName: string; code: string } | null;
  _count: { complaints: number; workOrders: number; pmTasks: number };
};

type EquipmentDetail = EquipmentRow & {
  history: {
    complaints: { id: string; code: string; title: string; status: string; priority: string; createdAt: string }[];
    workOrders: { id: string; code: string; title: string; status: string; priority: string; createdAt: string }[];
    pmTasks: { id: string; code: string; dueDate: string; status: string; completedAt: string | null }[];
    inspections: { id: string; code: string; title: string; type: string; status: string; overallCondition: string; inspectionDate: string }[];
  };
};

type QrData = { equipmentId: string; assetTag: string; name: string; url: string; dataUrl: string };

type CustomerOption = { id: string; companyName: string; code: string };
type LocationOption = { id: string; name: string; code: string };

type FormState = {
  name: string; serialNumber: string; manufacturer: string; model: string; category: string;
  customerId: string; locationId: string; installationDate: string; warrantyExpiry: string;
  pmFrequencyDays: string; notes: string;
};

const EMPTY_FORM: FormState = {
  name: "", serialNumber: "", manufacturer: "", model: "", category: "",
  customerId: "", locationId: "", installationDate: "", warrantyExpiry: "",
  pmFrequencyDays: "90", notes: "",
};

const CATEGORIES = ["HVAC", "ELECTRICAL", "PLUMBING", "LIFT", "FIRE_SAFETY", "SECURITY", "GENERAL"];

type FieldErrors = Record<string, string>;
function extractFieldErrors(e: unknown): FieldErrors {
  if (e instanceof ClientApiError && Array.isArray(e.details)) {
    const out: FieldErrors = {};
    for (const d of e.details as { path?: string; message?: string }[]) {
      if (d?.path && d?.message) out[d.path] = d.message;
    }
    return out;
  }
  return {};
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive mt-1">{msg}</p>;
}

export function EquipmentModule() {
  const { user } = useSession();
  const { toast } = useToast();
  const can = (p: Permission) => !!user?.permissions.includes(p);

  const [rows, setRows] = useState<EquipmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationsAvailable, setLocationsAvailable] = useState<boolean | null>(null);

  // Create dialog + draft protection (mandatory)
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const draft = useDraft<FormState>({ formKey: "equipment.create", initial: EMPTY_FORM });

  // Edit dialog
  const [editRow, setEditRow] = useState<EquipmentRow | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [editStatus, setEditStatus] = useState("ACTIVE");

  // Detail dialog
  const [detail, setDetail] = useState<EquipmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // QR dialog
  const [qr, setQr] = useState<QrData | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  // Retire confirm
  const [retireRow, setRetireRow] = useState<EquipmentRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<EquipmentRow[]>(`/api/v1/equipment${qs({ pageSize: 200 })}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCustomers = useCallback(async () => {
    try {
      const res = await api.get<CustomerOption[]>(`/api/v1/customers${qs({ pageSize: 200, status: "ACTIVE" })}`);
      setCustomers(res.data);
    } catch {
      setCustomers([]); // will degrade to "—" in the select
    }
  }, []);

  const loadLocations = useCallback(async () => {
    try {
      const res = await api.get<LocationOption[]>("/api/v1/locations");
      setLocations(res.data ?? []);
      setLocationsAvailable(true);
    } catch {
      setLocations([]);
      setLocationsAvailable(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadCustomers(); }, [loadCustomers]);
  useEffect(() => { loadLocations(); }, [loadLocations]);

  const openDetail = (row: EquipmentRow) => {
    setDetail(null);
    setDetailLoading(true);
    api.get<EquipmentDetail>(`/api/v1/equipment/${row.id}`)
      .then((res) => setDetail(res.data))
      .catch((e) => toast({ title: "Could not load equipment", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" }))
      .finally(() => setDetailLoading(false));
  };

  const openQr = (row: EquipmentRow) => {
    setQr(null);
    setQrLoading(true);
    api.get<QrData>(`/api/v1/equipment/${row.id}/qr`)
      .then((res) => setQr(res.data))
      .catch((e) => toast({ title: "Could not generate QR", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" }))
      .finally(() => setQrLoading(false));
  };

  const openEdit = (row: EquipmentRow) => {
    setFieldErrors({});
    setEditRow(row);
    setEditStatus(row.status);
    setEditForm({
      name: row.name, serialNumber: row.serialNumber, manufacturer: row.manufacturer,
      model: row.model, category: row.category, customerId: row.customerId ?? "",
      locationId: row.location?.id ?? "", installationDate: row.installationDate ? row.installationDate.slice(0, 10) : "",
      warrantyExpiry: row.warrantyExpiry ? row.warrantyExpiry.slice(0, 10) : "",
      pmFrequencyDays: String(row.pmFrequencyDays), notes: row.notes,
    });
  };

  function payloadFor(f: FormState) {
    return {
      name: f.name,
      serialNumber: f.serialNumber || undefined,
      manufacturer: f.manufacturer || undefined,
      model: f.model || undefined,
      category: f.category || undefined,
      customerId: f.customerId || null,
      locationId: f.locationId || null,
      installationDate: f.installationDate || undefined,
      warrantyExpiry: f.warrantyExpiry || undefined,
      pmFrequencyDays: f.pmFrequencyDays === "" ? undefined : Number(f.pmFrequencyDays),
      notes: f.notes || undefined,
    };
  }

  async function submitCreate() {
    setSaving(true);
    setFieldErrors({});
    try {
      const res = await api.post<EquipmentRow>("/api/v1/equipment", payloadFor(draft.value));
      toast({ title: "Equipment registered", description: `${res.data.name} (${res.data.assetTag}) — QR label ready.` });
      draft.reset(EMPTY_FORM);
      setCreateOpen(false);
      load();
    } catch (e) {
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not register equipment", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit() {
    if (!editRow) return;
    setSaving(true);
    setFieldErrors({});
    try {
      await api.patch(`/api/v1/equipment/${editRow.id}`, { ...payloadFor(editForm), status: editStatus });
      toast({ title: "Equipment updated", description: `${editForm.name} saved.` });
      setEditRow(null);
      load();
    } catch (e) {
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not update equipment", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitRetire() {
    if (!retireRow) return;
    setSaving(true);
    try {
      await api.del(`/api/v1/equipment/${retireRow.id}`);
      toast({ title: "Equipment retired", description: `${retireRow.assetTag} is now RETIRED — its maintenance history is preserved.` });
      setRetireRow(null);
      load();
    } catch (e) {
      toast({ title: "Could not retire equipment", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function downloadQr() {
    if (!qr) return;
    const a = document.createElement("a");
    a.href = qr.dataUrl;
    a.download = `qr-${qr.assetTag}.png`;
    a.click();
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
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openQr(r)} aria-label={`QR label for ${r.assetTag}`}>
            <QrCode className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openDetail(r)} aria-label={`History for ${r.assetTag}`}>
            <FileText className="h-4 w-4" />
          </Button>
          {can("equipment.update") && r.status !== "RETIRED" ? (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(r)} aria-label={`Edit ${r.assetTag}`}>
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
          {can("equipment.delete") && r.status !== "RETIRED" ? (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setRetireRow(r)} aria-label={`Retire ${r.assetTag}`}>
              <Archive className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ),
      className: "w-4",
    },
  ];

  const formFields = (f: FormState, set: (patch: Partial<FormState>) => void, errs: FieldErrors, idp: string) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="sm:col-span-2">
        <Label htmlFor={`${idp}-name`}>Equipment name *</Label>
        <Input id={`${idp}-name`} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Chiller #1 — Level 3 Plant Room" />
        <FieldError msg={errs.name} />
      </div>
      <div>
        <Label htmlFor={`${idp}-serial`}>Serial number</Label>
        <Input id={`${idp}-serial`} value={f.serialNumber} onChange={(e) => set({ serialNumber: e.target.value })} />
      </div>
      <div>
        <Label htmlFor={`${idp}-category`}>Category</Label>
        <Select value={f.category || "GENERAL"} onValueChange={(v) => set({ category: v })}>
          <SelectTrigger id={`${idp}-category`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c.replace(/_/g, " ")}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor={`${idp}-manu`}>Manufacturer</Label>
        <Input id={`${idp}-manu`} value={f.manufacturer} onChange={(e) => set({ manufacturer: e.target.value })} />
      </div>
      <div>
        <Label htmlFor={`${idp}-model`}>Model</Label>
        <Input id={`${idp}-model`} value={f.model} onChange={(e) => set({ model: e.target.value })} />
      </div>
      <div>
        <Label htmlFor={`${idp}-cust`}>Customer</Label>
        <Select value={f.customerId || "none"} onValueChange={(v) => set({ customerId: v === "none" ? "" : v })}>
          <SelectTrigger id={`${idp}-cust`}><SelectValue placeholder="Unassigned" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— Unassigned —</SelectItem>
            {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.companyName}</SelectItem>)}
          </SelectContent>
        </Select>
        <FieldError msg={errs.customerId} />
      </div>
      <div>
        <Label htmlFor={`${idp}-loc`}>Location</Label>
        {locationsAvailable === false ? (
          <p className="text-sm text-muted-foreground pt-2">Locations module not available yet.</p>
        ) : (
          <Select value={f.locationId || "none"} onValueChange={(v) => set({ locationId: v === "none" ? "" : v })}>
            <SelectTrigger id={`${idp}-loc`}><SelectValue placeholder="No location" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— No location —</SelectItem>
              {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <FieldError msg={errs.locationId} />
      </div>
      <div>
        <Label htmlFor={`${idp}-inst`}>Installation date</Label>
        <Input id={`${idp}-inst`} type="date" value={f.installationDate} onChange={(e) => set({ installationDate: e.target.value })} />
        <FieldError msg={errs.installationDate} />
      </div>
      <div>
        <Label htmlFor={`${idp}-warr`}>Warranty expiry</Label>
        <Input id={`${idp}-warr`} type="date" value={f.warrantyExpiry} onChange={(e) => set({ warrantyExpiry: e.target.value })} />
        <FieldError msg={errs.warrantyExpiry} />
      </div>
      <div>
        <Label htmlFor={`${idp}-pm`}>PM cycle (days)</Label>
        <Input id={`${idp}-pm`} inputMode="numeric" value={f.pmFrequencyDays} onChange={(e) => set({ pmFrequencyDays: e.target.value.replace(/\D/g, "") })} />
        <FieldError msg={errs.pmFrequencyDays} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`${idp}-notes`}>Notes</Label>
        <Textarea id={`${idp}-notes`} rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Capacity, access notes…" />
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Equipment"
        subtitle="Asset register with QR scan-to-open labels"
        actions={
          can("equipment.create") ? (
            <Button onClick={() => { setFieldErrors({}); setCreateOpen(true); }}>
              <Plus className="h-4 w-4 mr-1.5" /> New Equipment
            </Button>
          ) : null
        }
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
          onRowClick={openDetail}
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

      {/* Create dialog (draft-protected) */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Register equipment</DialogTitle>
            <DialogDescription>Asset tag (EQ-…) and QR token are generated automatically.</DialogDescription>
          </DialogHeader>

          {draft.draftExists ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
              <span className="flex-1 min-w-[140px]">You have an unsent draft from a previous session.</span>
              <Button size="sm" variant="outline" onClick={draft.restore}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore draft
              </Button>
              <Button size="sm" variant="ghost" onClick={draft.discard}>Discard</Button>
            </div>
          ) : draft.dirty && draft.lastSavedAt ? (
            <p className="text-xs text-muted-foreground">Draft saved automatically at {draft.lastSavedAt.toLocaleTimeString()} — restored automatically if you leave.</p>
          ) : null}

          {formFields(draft.value, (patch) => draft.setValue(patch), fieldErrors, "eq")}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={saving}>{saving ? "Registering…" : "Register equipment"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit {editRow?.assetTag}</DialogTitle>
            <DialogDescription>Asset tag and QR token never change.</DialogDescription>
          </DialogHeader>
          {formFields(editForm, (patch) => setEditForm((f) => ({ ...f, ...patch })), fieldErrors, "eeq")}
          <div>
            <Label htmlFor="eeq-status">Status</Label>
            <Select value={editStatus} onValueChange={setEditStatus}>
              <SelectTrigger id="eeq-status" className="w-full sm:w-[240px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="UNDER_MAINTENANCE">Under maintenance</SelectItem>
                <SelectItem value="RETIRED">Retired</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR dialog */}
      <Dialog open={!!qr || qrLoading} onOpenChange={(o) => { if (!o) { setQr(null); setQrLoading(false); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>QR label</DialogTitle>
            <DialogDescription>Scanning opens this asset in the app (staff) or its portal view.</DialogDescription>
          </DialogHeader>
          {qr ? (
            <div className="space-y-3">
              <div className="flex flex-col items-center gap-2">
                { }
                <img src={qr.dataUrl} alt={`QR code for ${qr.assetTag}`} className="rounded-lg border p-2 w-56 h-56" />
                <div className="text-center">
                  <p className="font-medium">{qr.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">{qr.assetTag}</p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground break-all text-center">{qr.url}</p>
              <div className="grid grid-cols-2 gap-2 no-print">
                <Button variant="outline" onClick={downloadQr}>
                  <Download className="h-4 w-4 mr-1.5" /> Download
                </Button>
                <Button variant="outline" onClick={() => window.print()}>
                  <Printer className="h-4 w-4 mr-1.5" /> Print
                </Button>
              </div>
            </div>
          ) : (
            <LoadingState label="Generating QR…" rows={2} />
          )}
        </DialogContent>
      </Dialog>

      {/* Detail / history dialog */}
      <Dialog open={!!detail || detailLoading} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detailLoading ? "Loading…" : detail?.name}
              {detail ? <StatusBadge status={detail.status} /> : null}
            </DialogTitle>
            <DialogDescription>
              {detail ? `${detail.assetTag} · ${[detail.manufacturer, detail.model].filter(Boolean).join(" ") || "No model info"}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                <div><p className="text-xs text-muted-foreground">Customer</p><p className="truncate">{detail.customer?.companyName ?? "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Location</p><p className="truncate">{detail.location?.name ?? "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Installed</p><p>{fmtDate(detail.installationDate)}</p></div>
                <div><p className="text-xs text-muted-foreground">Warranty</p><p>{fmtDate(detail.warrantyExpiry)}</p></div>
                <div><p className="text-xs text-muted-foreground">Serial</p><p className="font-mono text-xs pt-0.5 truncate">{detail.serialNumber || "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Category</p><p>{detail.category.replace(/_/g, " ")}</p></div>
                <div><p className="text-xs text-muted-foreground">PM cycle</p><p>{detail.pmFrequencyDays} days</p></div>
                <div><p className="text-xs text-muted-foreground">QR token</p><p className="font-mono text-[10px] pt-1 truncate">{detail.qrToken}</p></div>
              </div>

              <HistorySection icon={<FileText className="h-3.5 w-3.5" />} title="Complaints" empty="No complaints on this unit."
                items={detail.history.complaints.map((c) => ({ id: c.id, code: c.code, primary: c.title, badge: c.status, secondary: fmtDate(c.createdAt), badge2: c.priority }))} />
              <HistorySection icon={<Wrench className="h-3.5 w-3.5" />} title="Work orders" empty="No work orders yet."
                items={detail.history.workOrders.map((w) => ({ id: w.id, code: w.code, primary: w.title, badge: w.status, secondary: fmtDate(w.createdAt), badge2: w.priority }))} />
              <HistorySection icon={<CalendarClock className="h-3.5 w-3.5" />} title="PM tasks" empty="No preventive maintenance scheduled."
                items={detail.history.pmTasks.map((p) => ({ id: p.id, code: p.code, primary: `Due ${fmtDate(p.dueDate)}`, badge: p.status, secondary: p.completedAt ? `Done ${fmtDate(p.completedAt)}` : "Not completed" }))} />
              <HistorySection icon={<SearchCheck className="h-3.5 w-3.5" />} title="Inspections" empty="No inspection reports linked."
                items={detail.history.inspections.map((i) => ({ id: i.id, code: i.code, primary: i.title, badge: i.status, secondary: fmtDate(i.inspectionDate), badge2: i.overallCondition }))} />

              {detail.notes ? (
                <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                  <p className="text-xs text-muted-foreground mb-1">Notes</p>
                  {detail.notes}
                </div>
              ) : null}
            </div>
          ) : (
            <LoadingState label="Loading equipment…" rows={3} />
          )}
        </DialogContent>
      </Dialog>

      {/* Retire confirm */}
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
            <AlertDialogAction disabled={saving} onClick={(e) => { e.preventDefault(); submitRetire(); }}>
              {saving ? "Working…" : "Retire equipment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type HistoryItem = { id: string; code: string; primary: string; badge: string; secondary: string; badge2?: string };

function HistorySection({ icon, title, items, empty }: { icon: ReactNode; title: string; items: HistoryItem[]; empty: string }) {
  return (
    <div>
      <p className="text-sm font-medium mb-2 flex items-center gap-1.5">{icon} {title} <span className="text-muted-foreground font-normal">({items.length})</span></p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-3 px-3 py-2">
              <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{it.code}</span>
              <span className="flex-1 min-w-0 truncate text-sm">{it.primary}</span>
              <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:block">{it.secondary}</span>
              {it.badge2 ? <StatusBadge status={it.badge2} /> : null}
              <StatusBadge status={it.badge} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
