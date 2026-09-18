"use client";

// Vehicles module — fleet register with status KPIs, dedicated create/edit
// pages, inline status transitions (quick action).
//
// NAVIGATION ARCHITECTURE (hash router, ui-store pages["vehicles"]):
//   []              → this list page
//   ["new"]         → VehiclesNewPage  (dedicated add-vehicle page)
//   [id, "edit"]    → VehiclesEditPage (dedicated edit page + retire AlertDialog)

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Truck, Wrench, CircleParking, Gauge } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { fmtDate } from "@/lib/hms/format";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { VehiclesNewPage } from "./new-page";
import { VehiclesEditPage } from "./edit-page";

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
  assignedTechnician?: { id: string; employeeNo: string; user?: { name?: string | null } | null } | null;
};

const VEHICLE_STATUSES = ["AVAILABLE", "IN_USE", "MAINTENANCE", "RETIRED"];

// ── Module router ──

export function VehiclesModule() {
  const seg = useUi((s) => s.pages["vehicles"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "new") return <VehiclesNewPage />;
  if (page.view === "edit" && page.id) return <VehiclesEditPage id={page.id} />;
  return <VehiclesList />;
}

// ── List page ──

function VehiclesList() {
  const { user } = useSession();
  const { toast } = useToast();

  const canManage = hasPerm(user, PERMISSIONS.vehicles_manage);

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
            <Button
              variant="outline" size="sm"
              onClick={() => navigateTo("vehicles", [v.id, "edit"])}
              aria-label={`Edit ${v.code}`}
            >
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
            <Button size="sm" onClick={() => navigateTo("vehicles", ["new"])}>
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
          action={canManage ? <Button size="sm" onClick={() => navigateTo("vehicles", ["new"])}><Plus className="h-4 w-4 mr-1.5" /> Add Vehicle</Button> : undefined}
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
    </div>
  );
}
