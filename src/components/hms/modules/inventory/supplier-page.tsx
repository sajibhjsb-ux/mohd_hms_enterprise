"use client";

// MOHD.HMS ENTERPRISE — Supplier create/edit (dedicated full page, inventory/suppliers view).
// Replaces the former supplier dialog (the Suppliers tab stays a LIST tab).
//   /inventory/suppliers/new      → create (pageFromSeg → { view: "suppliers", id: "new" })
//   /inventory/suppliers/{id}     → edit   (pageFromSeg → { view: "suppliers", id })
// Same POST /api/v1/suppliers and PATCH /api/v1/suppliers/{id} payloads and
// validation. Codes are generated automatically for new suppliers.
//
// Edit prefill source: resolved from GET /api/v1/suppliers (pageSize 200, the
// same list the Suppliers tab shows) by id — no single-supplier GET contract is
// used by this module (documented integration point).

import { useCallback, useEffect, useState } from "react";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, LoadingState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, type Permission } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Save, Truck } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type SupplierRow = {
  id: string;
  code: string;
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  status: string;
};

type SupForm = { name: string; contactPerson: string; email: string; phone: string; address: string };

const BLANK_SUP: SupForm = { name: "", contactPerson: "", email: "", phone: "", address: "" };

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

export function SupplierPage({ supplierId }: { supplierId?: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  // The former dialog used purchases_manage for supplier add/edit (canSupplier).
  const canSupplier = hasPerm(user, PERMISSIONS.purchases_manage satisfies Permission);

  const isEdit = !!supplierId && supplierId !== "new";

  const [supplier, setSupplier] = useState<SupplierRow | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<SupForm>(BLANK_SUP);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Central unsaved-changes guard wiring.
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  const load = useCallback(async () => {
    if (!isEdit) return;
    setLoading(true);
    setLoadError("");
    setDirty(false);
    try {
      const res = await api.get<SupplierRow[]>(`/api/v1/suppliers${qs({ pageSize: 200 })}`);
      const found = (Array.isArray(res.data) ? res.data : []).find((s) => s.id === supplierId) ?? null;
      setSupplier(found);
      if (found) {
        setForm({
          name: found.name,
          contactPerson: found.contactPerson,
          email: found.email,
          phone: found.phone,
          address: found.address,
        });
      }
    } catch (e) {
      setLoadError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [isEdit, supplierId]);

  useEffect(() => { if (canSupplier) load(); }, [canSupplier, load]);

  function patch(p: Partial<SupForm>) {
    setForm((prev) => ({ ...prev, ...p }));
    setDirty(true);
  }

  async function submitSupplier() {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      if (isEdit && supplier) {
        await api.patch(`/api/v1/suppliers/${supplier.id}`, form);
        toast({ title: "Supplier updated", description: "Open the Suppliers tab in Inventory to see it in the list." });
      } else {
        await api.post("/api/v1/suppliers", form);
        toast({ title: "Supplier created", description: "Open the Suppliers tab in Inventory to see it in the list." });
      }
      setDirty(false);
      setPageDirty(false);
      navigateTo("inventory");
    } catch (e) {
      toast({ title: "Could not save supplier", description: errMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canSupplier) {
    return (
      <EmptyState
        title="You don't have permission to manage suppliers"
        hint="Supplier records are limited to authorized roles. Contact your administrator if you believe this is a mistake."
      />
    );
  }

  const crumbs = [
    { label: "Inventory", href: "/inventory" },
    { label: "Suppliers", href: "/inventory" },
    isEdit ? { label: "Edit Supplier" } : { label: "New Supplier" },
  ];

  if (loading) {
    return (
      <PageShell backLabel="Back to Inventory" backHref="/inventory" crumbs={crumbs} title={isEdit ? "Edit supplier" : "New supplier"}>
        <LoadingState label="Loading supplier…" rows={4} />
      </PageShell>
    );
  }

  if (loadError) {
    return (
      <PageShell backLabel="Back to Inventory" backHref="/inventory" crumbs={crumbs} title={isEdit ? "Edit supplier" : "New supplier"}>
        <EmptyState title="Could not load this supplier" hint={loadError} />
      </PageShell>
    );
  }

  if (isEdit && !supplier) {
    return (
      <PageShell backLabel="Back to Inventory" backHref="/inventory" crumbs={crumbs} title="Edit supplier">
        <EmptyState title="Supplier not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Inventory"
      backHref="/inventory"
      crumbs={crumbs}
      title={isEdit && supplier ? `Edit ${supplier.name}` : "Add supplier"}
      description={isEdit ? "Update the supplier's contact details." : "Code is generated automatically for new suppliers."}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => navigateTo("inventory")} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submitSupplier} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create supplier"}
          </Button>
        </div>
      }
    >
      <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-6 space-y-4 max-w-3xl">
        {isEdit && supplier ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-mono text-xs text-muted-foreground">{supplier.code}</span>
            <StatusBadge status={supplier.status} />
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Truck className="h-4 w-4" /> New suppliers become available to purchase orders and inventory items immediately.
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Supplier name *" className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} />
          </Field>
          <Field label="Contact person">
            <Input value={form.contactPerson} onChange={(e) => patch({ contactPerson: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => patch({ phone: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Textarea value={form.address} onChange={(e) => patch({ address: e.target.value })} rows={3} />
          </Field>
        </div>

        {dirty ? (
          <p className="text-xs text-muted-foreground">Unsaved changes — leaving this page will prompt for confirmation.</p>
        ) : null}
      </div>
    </PageShell>
  );
}
