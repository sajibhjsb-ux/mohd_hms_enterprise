"use client";

// Vehicles module — fleet register with status KPIs, create/edit dialog,
// technician assignment, inline status transitions and retire (soft delete).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Truck, Wrench, WrenchIcon, CircleParking, Gauge } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { fmtDate } from "@/lib/hms/format";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type TechnicianRef = { id: string; employeeNo: string; user?: { name?: string | null } | null } | null;

type Vehicle = {
  id: string;
  code: string;
  registrationNo: string;
  make: string;
  model: string;
  type: string;
  status: string;
  odometer: number;
  lastServiceDate: string | null;
  nextServiceDue: string | null;
  notes: string;
  assignedTechnicianId: string | null;
  assignedTechnician?: TechnicianRef;
};

type TechOption = { id: string; label: string };

const VEHICLE_TYPES = ["VAN", "TRUCK", "CAR", "PICKUP", "OTHER"];
const VEHICLE_STATUSES = ["AVAILABLE", "IN_USE", "MAINTENANCE", "RETIRED"];

const emptyForm = {
  registrationNo: "",
  make: "",
  model: "",
  type: "VAN",
  assignedTechnicianId: "",
  status: "AVAILABLE",
  odometer: "",
  lastServiceDate: "",
  nextServiceDue: "",
  notes: "",
};

export function VehiclesModule() {
  const { user } = useSession();
  const { toast } = useToast();

  const canManage = hasPerm(user, PERMISSIONS.vehicles_manage);

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [techOptions, setTechOptions] = useState<TechOption[] | null>(null); // null = unavailable (403 / not yet loaded)
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Vehicle[]>("/api/v1/vehicles?pageSize=200");
      setVehicles(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load vehicles.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Technician options for assignment (hidden when the viewer lacks users.read).
  useEffect(() => {
    if (!canManage) return;
    (async () => {
      try {
        const res = await api.get<unknown[]>("/api/v1/technicians?pageSize=200");
        const options = (res.data ?? [])
          .map((raw) => {
            const t = raw as { id?: string; employeeNo?: string; name?: string; status?: string; user?: { name?: string | null; status?: string | null } | null };
            if (t.status === "DISABLED" || t.user?.status === "DISABLED") return null; // skip inactive technicians
            const id = String(t.id ?? "");
            const name = t.user?.name ?? t.name ?? "Technician";
            const label = t.employeeNo ? `${name} (${t.employeeNo})` : name;
            return id ? { id, label } : null;
          })
          .filter((o): o is TechOption => o !== null);
        setTechOptions(options);
      } catch {
        setTechOptions(null); // 403 for roles without users.read — hide the select
      }
    })();
  }, [canManage]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(
    () => ({
      available: vehicles.filter((v) => v.status === "AVAILABLE").length,
      inUse: vehicles.filter((v) => v.status === "IN_USE").length,
      maintenance: vehicles.filter((v) => v.status === "MAINTENANCE").length,
      retired: vehicles.filter((v) => v.status === "RETIRED").length,
    }),
    [vehicles]
  );

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (v: Vehicle) => {
    setEditing(v);
    setForm({
      registrationNo: v.registrationNo,
      make: v.make,
      model: v.model,
      type: v.type,
      assignedTechnicianId: v.assignedTechnicianId ?? "",
      status: v.status,
      odometer: String(v.odometer ?? 0),
      lastServiceDate: v.lastServiceDate ? v.lastServiceDate.slice(0, 10) : "",
      nextServiceDue: v.nextServiceDue ? v.nextServiceDue.slice(0, 10) : "",
      notes: v.notes ?? "",
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.registrationNo.trim()) {
      toast({ title: "Registration number is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        registrationNo: form.registrationNo.trim(),
        make: form.make.trim(),
        model: form.model.trim(),
        type: form.type,
        assignedTechnicianId: form.assignedTechnicianId || null,
        odometer: form.odometer === "" ? undefined : Number(form.odometer),
        lastServiceDate: form.lastServiceDate || null,
        nextServiceDue: form.nextServiceDue || null,
        notes: form.notes,
        ...(editing ? { status: form.status } : {}),
      };
      if (editing) {
        await api.patch(`/api/v1/vehicles/${editing.id}`, payload);
        toast({ title: "Vehicle updated", description: `${editing.code} saved.` });
      } else {
        await api.post("/api/v1/vehicles", payload);
        toast({ title: "Vehicle added", description: `${form.registrationNo.trim()} registered to the fleet.` });
      }
      setDialogOpen(false);
      await load();
    } catch (e) {
      toast({
        title: editing ? "Update failed" : "Could not add vehicle",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (vehicle: Vehicle, status: string) => {
    if (status === vehicle.status) return;
    setBusyId(vehicle.id);
    try {
      await api.patch(`/api/v1/vehicles/${vehicle.id}`, { status });
      toast({ title: "Status updated", description: `${vehicle.code} → ${humanize(status)}` });
      await load();
    } catch (e) {
      toast({
        title: "Status change failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const retire = async () => {
    if (!editing) return;
    if (!window.confirm(`Retire ${editing.code} (${editing.registrationNo})? The vehicle stays in the register as RETIRED.`)) return;
    setSaving(true);
    try {
      await api.del(`/api/v1/vehicles/${editing.id}`);
      toast({ title: "Vehicle retired", description: `${editing.code} marked as RETIRED.` });
      setDialogOpen(false);
      await load();
    } catch (e) {
      toast({
        title: "Retire failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const columns: Column<Vehicle>[] = [
    { key: "code", header: "Code", value: (v) => v.code, className: "font-medium whitespace-nowrap" },
    { key: "registrationNo", header: "Registration", value: (v) => v.registrationNo },
    {
      key: "makeModel",
      header: "Make / Model",
      value: (v) => `${v.make} ${v.model}`.trim(),
      render: (v) => `${v.make} ${v.model}`.trim() || "—",
    },
    { key: "type", header: "Type", value: (v) => v.type, render: (v) => humanize(v.type), hideOnMobile: true },
    {
      key: "technician",
      header: "Assigned Technician",
      value: (v) => v.assignedTechnician?.user?.name ?? "",
      render: (v) => v.assignedTechnician?.user?.name ?? <span className="text-muted-foreground">—</span>,
      hideOnMobile: true,
    },
    {
      key: "odometer",
      header: "Odometer",
      value: (v) => v.odometer,
      render: (v) => <span className="tabular-nums">{v.odometer.toLocaleString("en-MY")} km</span>,
      hideOnMobile: true,
    },
    {
      key: "nextServiceDue",
      header: "Next Service",
      value: (v) => v.nextServiceDue ?? "",
      render: (v) => fmtDate(v.nextServiceDue),
      hideOnMobile: true,
    },
    {
      key: "status",
      header: "Status",
      value: (v) => v.status,
      render: (v) =>
        canManage ? (
          <Select
            value={v.status}
            disabled={busyId === v.id}
            onValueChange={(next) => void changeStatus(v, next)}
          >
            <SelectTrigger className="h-8 w-[150px]" aria-label={`Status for ${v.code}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VEHICLE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <StatusBadge status={v.status} />
        ),
    },
    ...(canManage
      ? [{
          key: "actions",
          header: "",
          sortable: false,
          render: (v: Vehicle) => (
            <Button variant="outline" size="sm" onClick={() => openEdit(v)} aria-label={`Edit ${v.code}`}>
              Edit
            </Button>
          ),
        } satisfies Column<Vehicle>]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Vehicles"
        subtitle="Fleet register, assignments and service schedule"
        actions={
          canManage ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1.5" /> Add Vehicle
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard title="Available" value={stats.available} icon={<CircleParking className="h-5 w-5" />} tone="success" loading={loading} />
        <StatCard title="In Use" value={stats.inUse} icon={<Truck className="h-5 w-5" />} tone="warning" loading={loading} />
        <StatCard title="Maintenance" value={stats.maintenance} icon={<Wrench className="h-5 w-5" />} tone="danger" loading={loading} />
        <StatCard title="Retired" value={stats.retired} icon={<Gauge className="h-5 w-5" />} loading={loading} />
      </div>

      {loading ? (
        <LoadingState label="Loading fleet…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : vehicles.length === 0 ? (
        <EmptyState
          title="No vehicles registered"
          hint={canManage ? "Add the first vehicle to start tracking the fleet." : "No vehicles have been registered yet."}
          action={canManage ? <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1.5" /> Add Vehicle</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={vehicles}
          rowKey={(v) => v.id}
          searchPlaceholder="Search code, registration, make…"
          emptyTitle="No vehicles match"
        />
      )}

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto hms-scroll">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.code}` : "Add Vehicle"}</DialogTitle>
            <DialogDescription>
              {editing ? "Update registration, assignment or service details." : "Register a new vehicle to the fleet."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="veh-reg">Registration No *</Label>
              <Input
                id="veh-reg"
                value={form.registrationNo}
                onChange={(e) => setForm((f) => ({ ...f, registrationNo: e.target.value }))}
                placeholder="WXY 1234"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                <SelectTrigger aria-label="Vehicle type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VEHICLE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="veh-make">Make</Label>
              <Input id="veh-make" value={form.make} onChange={(e) => setForm((f) => ({ ...f, make: e.target.value }))} placeholder="Toyota" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="veh-model">Model</Label>
              <Input id="veh-model" value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} placeholder="Hilux" />
            </div>

            {canManage && techOptions !== null ? (
              <div className="space-y-1.5">
                <Label>Assigned Technician</Label>
                <Select
                  value={form.assignedTechnicianId || "NONE"}
                  onValueChange={(v) => setForm((f) => ({ ...f, assignedTechnicianId: v === "NONE" ? "" : v }))}
                >
                  <SelectTrigger aria-label="Assigned technician"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">Unassigned</SelectItem>
                    {techOptions.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Assigning moves the technician off any other vehicle.</p>
              </div>
            ) : null}

            {editing ? (
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger aria-label="Vehicle status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VEHICLE_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="veh-odometer">Odometer (km)</Label>
              <Input
                id="veh-odometer"
                type="number"
                min={0}
                value={form.odometer}
                onChange={(e) => setForm((f) => ({ ...f, odometer: e.target.value }))}
                placeholder="0"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="veh-last-service">Last Service Date</Label>
              <Input
                id="veh-last-service"
                type="date"
                value={form.lastServiceDate}
                onChange={(e) => setForm((f) => ({ ...f, lastServiceDate: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="veh-next-service">Next Service Due</Label>
              <Input
                id="veh-next-service"
                type="date"
                value={form.nextServiceDue}
                onChange={(e) => setForm((f) => ({ ...f, nextServiceDue: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="veh-notes">Notes</Label>
              <Textarea
                id="veh-notes"
                rows={3}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Service history, accessories, remarks…"
              />
            </div>
          </div>

          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-between gap-2">
            {editing && editing.status !== "RETIRED" ? (
              <Button variant="destructive" size="sm" onClick={() => void retire()} disabled={saving}>
                <WrenchIcon className="h-4 w-4 mr-1.5" /> Retire Vehicle
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : editing ? "Save Changes" : "Add Vehicle"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
