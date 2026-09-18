"use client";

// MOHD.HMS ENTERPRISE — dedicated Edit Equipment page (equipment/{id}/edit view).
// Replaces the former edit modal. Loads the authoritative record by id
// (GET /api/v1/equipment/{id}) so direct URLs / deep links work, patches via
// PATCH /api/v1/equipment/{id} — same payload contract, same error mapping.
// Asset tag and QR token never change.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Pencil, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EquipmentFormFields, extractFieldErrors, payloadFor,
  type CustomerOption, type EquipmentDetail, type FieldErrors, type FormState, type LocationOption,
} from "./shared";

const STATUSES = ["ACTIVE", "UNDER_MAINTENANCE", "RETIRED"] as const;

function formFromRow(row: EquipmentDetail): FormState {
  return {
    name: row.name, serialNumber: row.serialNumber, manufacturer: row.manufacturer,
    model: row.model, category: row.category, customerId: row.customerId ?? "",
    locationId: row.location?.id ?? "",
    installationDate: row.installationDate ? row.installationDate.slice(0, 10) : "",
    warrantyExpiry: row.warrantyExpiry ? row.warrantyExpiry.slice(0, 10) : "",
    pmFrequencyDays: String(row.pmFrequencyDays), notes: row.notes,
  };
}

export function EquipmentEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canUpdate = hasPerm(user, PERMISSIONS.equipment_update);

  const [row, setRow] = useState<EquipmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null);
  const [status, setStatus] = useState("ACTIVE");
  const pristine = useRef<string>("");

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  // ── Reference data (same endpoints as the former dialog) ──
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationsAvailable, setLocationsAvailable] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<EquipmentDetail>(`/api/v1/equipment/${id}`);
      const next = formFromRow(res.data);
      setRow(res.data);
      setForm(next);
      setStatus(res.data.status);
      pristine.current = JSON.stringify({ form: next, status: res.data.status });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this equipment.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (canUpdate) load(); }, [canUpdate, load]);

  useEffect(() => {
    if (!canUpdate) return;
    let alive = true;
    api.get<CustomerOption[]>(`/api/v1/customers${qs({ pageSize: 200, status: "ACTIVE" })}`)
      .then((r) => { if (alive) setCustomers(r.data); })
      .catch(() => { if (alive) setCustomers([]); });
    api.get<LocationOption[]>("/api/v1/locations")
      .then((r) => { if (alive) { setLocations(r.data ?? []); setLocationsAvailable(true); } })
      .catch(() => { if (alive) { setLocations([]); setLocationsAvailable(false); } });
    return () => { alive = false; };
  }, [canUpdate]);

  // ── Dirty-state wiring (central router guard protects unsaved edits) ──
  const dirty = !!form && JSON.stringify({ form, status }) !== pristine.current;
  useEffect(() => {
    if (!canUpdate) return;
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, canUpdate, setPageDirty]);

  async function submitEdit() {
    if (!form) return;
    setSaving(true);
    setFieldErrors({});
    try {
      await api.patch(`/api/v1/equipment/${id}`, { ...payloadFor(form), status });
      toast({ title: "Equipment updated", description: `${form.name} saved.` });
      setPageDirty(false);
      navigateTo("equipment", [id]);
    } catch (e) {
      // Keep every user-entered value on failure — show the errors and allow retry.
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not update equipment", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canUpdate) {
    return (
      <PageShell backLabel="Back to Equipment" backHref="/equipment" title="Edit equipment">
        <EmptyState
          title="You don't have permission to edit equipment"
          hint="Asset editing is limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  if (loading && !row) {
    return (
      <PageShell backLabel="Back to Equipment" backHref="/equipment" title="Edit equipment">
        <LoadingState label="Loading equipment…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !row) {
    return (
      <PageShell backLabel="Back to Equipment" backHref="/equipment" title="Edit equipment">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!form) return null;

  const actions = (
    <Button onClick={submitEdit} disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
      {saving ? "Saving…" : "Save changes"}
    </Button>
  );

  return (
    <PageShell
      backLabel="Back to Equipment"
      backHref={`/equipment/${encodeURIComponent(id)}`}
      crumbs={[
        { label: "Equipment", href: "/equipment" },
        { label: row?.assetTag ?? id, href: `/equipment/${encodeURIComponent(id)}` },
        { label: "Edit" },
      ]}
      title={`Edit ${row?.assetTag ?? ""}`}
      description={[row?.name, "Asset tag and QR token never change."].filter(Boolean).join(" · ")}
      actions={<div className="hidden sm:flex items-center gap-2">{actions}</div>}
    >
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Pencil className="h-4 w-4 text-muted-foreground" /> Asset details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <EquipmentFormFields
            f={form}
            set={(patch) => setForm((f) => (f ? { ...f, ...patch } : f))}
            errs={fieldErrors}
            idp="eeq"
            customers={customers}
            locations={locations}
            locationsAvailable={locationsAvailable}
          />

          <div>
            <Label htmlFor="eeq-status">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="eeq-status" className="w-full sm:w-[240px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Sticky mobile action bar */}
      <div className={cn("sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print")}>
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          <Button className="flex-1" onClick={submitEdit} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
