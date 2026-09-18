"use client";

// MOHD.HMS ENTERPRISE — dedicated Register Equipment page (equipment/new view).
// Replaces the former "Register equipment" modal as the primary asset entry
// mechanism. Same API (POST /api/v1/equipment), same draft protection
// (formKey "equipment.create"), same server zod error mapping — no popup.

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RotateCcw, Save, Loader2, PackageOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EMPTY_FORM, EquipmentFormFields, extractFieldErrors, payloadFor,
  type CustomerOption, type FieldErrors, type FormState, type LocationOption, type EquipmentRow,
} from "./shared";

export function EquipmentNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canCreate = hasPerm(user, PERMISSIONS.equipment_create);

  // Draft protection (mandatory) — same formKey as the old dialog.
  const draft = useDraft<FormState>({ formKey: "equipment.create", initial: EMPTY_FORM });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  // ── Reference data (same endpoints as the former dialog) ──
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationsAvailable, setLocationsAvailable] = useState<boolean | null>(null);

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

  useEffect(() => {
    if (!canCreate) return;
    loadCustomers();
    loadLocations();
  }, [canCreate, loadCustomers, loadLocations]);

  // ── Dirty-state wiring (central router guard + data protection) ──
  useEffect(() => {
    if (!canCreate) return;
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, canCreate, setPageDirty]);

  async function submitCreate() {
    setSaving(true);
    setFieldErrors({});
    try {
      const res = await api.post<EquipmentRow>("/api/v1/equipment", payloadFor(draft.value));
      toast({ title: "Equipment registered", description: `${res.data.name} (${res.data.assetTag}) — QR label ready.` });
      draft.reset(EMPTY_FORM);
      setPageDirty(false);
      // Continue the workflow on the asset's dedicated detail page.
      navigateTo("equipment", [res.data.id]);
    } catch (e) {
      // Keep every user-entered value on failure — show the errors and allow retry.
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not register equipment", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canCreate) {
    return (
      <PageShell backLabel="Back to Equipment" backHref="/equipment" title="Register equipment">
        <EmptyState
          title="You don't have permission to register equipment"
          hint="Asset registration is limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const actions = (
    <>
      <Button variant="outline" onClick={draft.saveNow} disabled={saving}>
        <Save className="h-4 w-4 mr-1.5" /> Save Draft
      </Button>
      <Button onClick={submitCreate} disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <PackageOpen className="h-4 w-4 mr-1.5" />}
        {saving ? "Registering…" : "Register equipment"}
      </Button>
    </>
  );

  return (
    <PageShell
      backLabel="Back to Equipment"
      backHref="/equipment"
      crumbs={[{ label: "Equipment", href: "/equipment" }, { label: "New Equipment" }]}
      title="Register equipment"
      description="Asset tag (EQ-…) and QR token are generated automatically."
      actions={<div className="hidden sm:flex items-center gap-2">{actions}</div>}
    >
      {/* Recoverable draft banner */}
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

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Asset details</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">Attach a customer and location so complaints and work orders route correctly.</p>
        </CardHeader>
        <CardContent>
          <EquipmentFormFields
            f={draft.value}
            set={(patch) => draft.setValue(patch)}
            errs={fieldErrors}
            idp="eq"
            customers={customers}
            locations={locations}
            locationsAvailable={locationsAvailable}
          />
        </CardContent>
      </Card>

      {/* Autosave hint */}
      <p className="mt-3 text-xs text-muted-foreground">
        {draft.dirty
          ? "Draft auto-saves as you type — safe to leave and restore later."
          : draft.lastSavedAt
            ? `Draft saved at ${draft.lastSavedAt.toLocaleTimeString()}.`
            : "Tip: use Save Draft to keep incomplete registrations for later."}
      </p>

      {/* Sticky mobile action bar */}
      <div className={cn("sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print")}>
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          <Button variant="outline" className="flex-1" onClick={draft.saveNow} disabled={saving}>
            <Save className="h-4 w-4 mr-1.5" /> Save Draft
          </Button>
          <Button className="flex-1" onClick={submitCreate} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <PackageOpen className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : "Register"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
