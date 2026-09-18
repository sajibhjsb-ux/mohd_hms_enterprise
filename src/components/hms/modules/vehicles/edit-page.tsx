"use client";

// MOHD.HMS ENTERPRISE — dedicated "Edit Vehicle" page (vehicles/{id}/edit view).
// Replaces the edit side of the old vehicle dialog. Prefills from the fleet
// list (the vehicle detail endpoint exposes PATCH/DELETE only), hosts the
// destructive Retire action as an AlertDialog — the module's only dialog.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Save, WrenchIcon } from "lucide-react";
import {
  EMPTY_VEHICLE_FORM, VehicleFormFields,
  type TechOption, type VehicleForm,
} from "./vehicle-fields";

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
};

function toForm(v: Vehicle): VehicleForm {
  return {
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
  };
}

export function VehiclesEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.vehicles_manage);

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<VehicleForm>(EMPTY_VEHICLE_FORM);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [retiring, setRetiring] = useState(false);

  // Technician options for assignment (hidden when the viewer lacks users.read).
  const [techOptions, setTechOptions] = useState<TechOption[] | null>(null);

  // Prefill via the fleet list — GET /api/v1/vehicles/{id} does not exist (PATCH/DELETE only).
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<Vehicle[]>("/api/v1/vehicles?pageSize=200");
      const found = (res.data ?? []).find((v) => v.id === id) ?? null;
      if (!found) {
        setVehicle(null);
      } else {
        setVehicle(found);
        setForm(toForm(found));
        setDirty(false);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Unable to load this vehicle.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    (async () => {
      try {
        const res = await api.get<unknown[]>("/api/v1/technicians?pageSize=200");
        const options = (res.data ?? [])
          .map((raw) => {
            const t = raw as { id?: string; employeeNo?: string; name?: string; status?: string; user?: { name?: string | null; status?: string | null } | null };
            if (t.status === "DISABLED" || t.user?.status === "DISABLED") return null; // skip inactive technicians
            const tid = String(t.id ?? "");
            const name = t.user?.name ?? t.name ?? "Technician";
            const label = t.employeeNo ? `${name} (${t.employeeNo})` : name;
            return tid ? { id: tid, label } : null;
          })
          .filter((o): o is TechOption => o !== null);
        if (alive) setTechOptions(options);
      } catch {
        if (alive) setTechOptions(null); // 403 for roles without users.read — hide the select
      }
    })();
    return () => { alive = false; };
  }, [canManage]);

  // ── Dirty-state wiring (central router guard + data protection) ──
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  const update = (patch: Partial<VehicleForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  async function save() {
    if (!vehicle) return;
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
        status: form.status,
        odometer: form.odometer === "" ? undefined : Number(form.odometer),
        lastServiceDate: form.lastServiceDate || null,
        nextServiceDue: form.nextServiceDue || null,
        notes: form.notes,
      };
      await api.patch(`/api/v1/vehicles/${vehicle.id}`, payload);
      toast({ title: "Vehicle updated", description: `${vehicle.code} saved.` });
      setDirty(false);
      setPageDirty(false);
      navigateTo("vehicles");
    } catch (e) {
      // Keep every user-entered value on failure — show the error and allow retry.
      toast({
        title: "Update failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function retire() {
    if (!vehicle) return;
    setRetiring(true);
    try {
      await api.del(`/api/v1/vehicles/${vehicle.id}`);
      toast({ title: "Vehicle retired", description: `${vehicle.code} marked as RETIRED.` });
      setDirty(false);
      setPageDirty(false);
      navigateTo("vehicles");
    } catch (e) {
      toast({
        title: "Retire failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
      setConfirmRetire(false);
    } finally {
      setRetiring(false);
    }
  }

  const backLabel = "Back to Vehicles";
  const backHref = "#/vehicles";

  if (!canManage) {
    return (
      <PageShell backLabel={backLabel} backHref={backHref} title="Edit vehicle">
        <EmptyState
          title="You don't have permission to manage vehicles"
          hint="Editing vehicles is limited to supervisors, admins and super admins. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  if (loading && !vehicle) {
    return (
      <PageShell backLabel={backLabel} backHref={backHref} title="Edit vehicle">
        <LoadingState label="Loading vehicle…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !vehicle) {
    return (
      <PageShell backLabel={backLabel} backHref={backHref} title="Edit vehicle">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!vehicle) {
    return (
      <PageShell backLabel={backLabel} backHref={backHref} title="Edit vehicle">
        <EmptyState title="Vehicle not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel={backLabel}
      backHref={backHref}
      crumbs={[{ label: "Vehicles", href: "#/vehicles" }, { label: vehicle.code, href: "#/vehicles" }, { label: "Edit" }]}
      title={`Edit ${vehicle.code}`}
      description="Update registration, assignment or service details."
      actions={
        <div className="hidden sm:block">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      }
    >
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Vehicle details</CardTitle>
        </CardHeader>
        <CardContent>
          <VehicleFormFields form={form} onChange={update} techOptions={techOptions} isEdit />
        </CardContent>
      </Card>

      {/* Destructive zone — retire stays on the edit page as the module's only dialog */}
      {vehicle.status !== "RETIRED" ? (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-sm">
            <p className="font-medium text-destructive">Retire this vehicle</p>
            <p className="text-muted-foreground">The vehicle stays in the register as RETIRED and can no longer be assigned.</p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setConfirmRetire(true)} disabled={saving || retiring} className="shrink-0">
            <WrenchIcon className="h-4 w-4 mr-1.5" /> Retire Vehicle
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">This vehicle is retired — reactivate it via the status select above.</p>
      )}

      {/* Sticky mobile action bar */}
      <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          {vehicle.status !== "RETIRED" ? (
            <Button variant="outline" className="flex-1 text-destructive" onClick={() => setConfirmRetire(true)} disabled={saving || retiring}>
              <WrenchIcon className="h-4 w-4 mr-1.5" /> Retire
            </Button>
          ) : null}
          <Button className="flex-1" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </div>

      {/* Retire confirmation — the only dialog in this module */}
      <AlertDialog open={confirmRetire} onOpenChange={(open) => { if (!open && !retiring) setConfirmRetire(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {vehicle.code} ({vehicle.registrationNo})?</AlertDialogTitle>
            <AlertDialogDescription>
              The vehicle stays in the register as RETIRED. Its technician assignment is released and it can no longer be booked for work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retiring}>Keep vehicle</AlertDialogCancel>
            <AlertDialogAction
              disabled={retiring}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); void retire(); }}
            >
              {retiring ? "Retiring…" : "Retire Vehicle"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
