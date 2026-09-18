"use client";

// MOHD.HMS ENTERPRISE — dedicated "Add Vehicle" page (vehicles/new view).
// Replaces the create side of the old vehicle dialog. Shares its field set
// with the edit page via the shared renderer. No new APIs.

import { useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Plus, Truck } from "lucide-react";
import {
  EMPTY_VEHICLE_FORM, VehicleFormFields,
  type TechOption, type VehicleForm,
} from "./vehicle-fields";

export function VehiclesNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.vehicles_manage);

  const [form, setForm] = useState<VehicleForm>(EMPTY_VEHICLE_FORM);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Technician options for assignment (hidden when the viewer lacks users.read).
  const [techOptions, setTechOptions] = useState<TechOption[] | null>(null);
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
            const id = String(t.id ?? "");
            const name = t.user?.name ?? t.name ?? "Technician";
            const label = t.employeeNo ? `${name} (${t.employeeNo})` : name;
            return id ? { id, label } : null;
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
      };
      await api.post("/api/v1/vehicles", payload);
      toast({ title: "Vehicle added", description: `${form.registrationNo.trim()} registered to the fleet.` });
      setDirty(false);
      setPageDirty(false);
      navigateTo("vehicles");
    } catch (e) {
      // Keep every user-entered value on failure — show the error and allow retry.
      toast({
        title: "Could not add vehicle",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageShell backLabel="Back to Vehicles" backHref="/vehicles" title="Add Vehicle">
        <EmptyState
          title="You don't have permission to manage vehicles"
          hint="Adding vehicles is limited to supervisors, admins and super admins. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Vehicles"
      backHref="/vehicles"
      crumbs={[{ label: "Vehicles", href: "/vehicles" }, { label: "Add Vehicle" }]}
      title="Add Vehicle"
      description="Register a new vehicle to the fleet."
      actions={
        <div className="hidden sm:block">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : "Add Vehicle"}
          </Button>
        </div>
      }
    >
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Vehicle details</CardTitle>
        </CardHeader>
        <CardContent>
          <VehicleFormFields form={form} onChange={update} techOptions={techOptions} isEdit={false} />
        </CardContent>
      </Card>

      {/* Sticky mobile action bar */}
      <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3">
          <Button className="w-full" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Truck className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : "Add Vehicle"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
