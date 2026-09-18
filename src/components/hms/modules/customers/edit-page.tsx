"use client";

// MOHD.HMS ENTERPRISE — dedicated Edit Customer page (customers/{id}/edit view).
// Replaces the former edit dialog. Same API (GET + PATCH /api/v1/customers/{id}),
// same RBAC and field-level error preservation — no popup. Direct URLs work:
// the record is fetched by id when the page is opened from a link.
//
// Status and portal accounts are NOT editable here — they are managed from the
// list (status via list actions, portal during provisioning), as before.

import { useCallback, useEffect, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Save } from "lucide-react";

// ── Types ──

type CustomerEditable = {
  id: string;
  code: string;
  companyName: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  status: string;
  notes: string;
};

type FormState = {
  companyName: string; contactPerson: string; email: string; phone: string;
  address: string; city: string; notes: string;
};

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

function toForm(c: CustomerEditable): FormState {
  return {
    companyName: c.companyName, contactPerson: c.contactPerson, email: c.email,
    phone: c.phone, address: c.address, city: c.city, notes: c.notes,
  };
}

function formEquals(a: FormState, b: FormState): boolean {
  return a.companyName === b.companyName && a.contactPerson === b.contactPerson
    && a.email === b.email && a.phone === b.phone && a.address === b.address
    && a.city === b.city && a.notes === b.notes;
}

// ── Page ──

export function CustomerEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canUpdate = hasPerm(user, PERMISSIONS.customers_update);

  const [customer, setCustomer] = useState<CustomerEditable | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<CustomerEditable>(`/api/v1/customers/${id}`);
      setCustomer(res.data);
      const f = toForm(res.data);
      setForm(f);
      setInitial(f);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this customer.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // ── Dirty-state wiring (central router guard protects typed edits) ──
  const dirty = !!form && !!initial && !formEquals(form, initial);
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function submitEdit() {
    if (!customer || !form) return;
    setSaving(true);
    setFieldErrors({});
    try {
      await api.patch(`/api/v1/customers/${customer.id}`, {
        companyName: form.companyName,
        contactPerson: form.contactPerson,
        email: form.email,
        phone: form.phone,
        address: form.address || undefined,
        city: form.city || undefined,
        notes: form.notes || undefined,
      });
      toast({ title: "Customer updated", description: `${form.companyName} saved.` });
      setPageDirty(false);
      navigateTo("customers", [customer.id]);
    } catch (e) {
      // Keep every edited value on failure — show the error and allow retry.
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not update customer", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canUpdate) {
    return (
      <PageShell
        backLabel="Back to Customers"
        backHref="#/customers"
        crumbs={[{ label: "Customers", href: "#/customers" }, { label: "Edit" }]}
        title="Edit customer"
      >
        <EmptyState
          title="You don't have permission to edit customers"
          hint="Customer editing is limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  if (loading && !customer) {
    return (
      <PageShell
        backLabel="Back to Customers"
        backHref="#/customers"
        crumbs={[{ label: "Customers", href: "#/customers" }, { label: "Edit" }]}
        title="Edit customer"
      >
        <LoadingState label="Loading customer…" rows={4} />
      </PageShell>
    );
  }

  if (loadError && !customer) {
    return (
      <PageShell
        backLabel="Back to Customers"
        backHref="#/customers"
        crumbs={[{ label: "Customers", href: "#/customers" }, { label: "Edit" }]}
        title="Edit customer"
      >
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!customer || !form) {
    return (
      <PageShell
        backLabel="Back to Customers"
        backHref="#/customers"
        crumbs={[{ label: "Customers", href: "#/customers" }, { label: "Edit" }]}
        title="Edit customer"
      >
        <EmptyState title="Customer not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const set = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <PageShell
      backLabel="Back to Customer"
      backHref={`#/customers/${encodeURIComponent(customer.id)}`}
      crumbs={[
        { label: "Customers", href: "#/customers" },
        { label: customer.companyName, href: `#/customers/${encodeURIComponent(customer.id)}` },
        { label: "Edit" },
      ]}
      title={`Edit ${customer.companyName}`}
      description={`Code ${customer.code} · status and portal accounts are managed from the list.`}
      actions={
        <Button onClick={submitEdit} disabled={saving || !dirty} className="no-print">
          {saving ? <Save className="h-4 w-4 mr-1.5 animate-pulse" /> : <Save className="h-4 w-4 mr-1.5" />}
          {saving ? "Saving…" : "Save changes"}
        </Button>
      }
    >
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Customer details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Label htmlFor="cus-e-name">Company name</Label>
              <Input id="cus-e-name" value={form.companyName} onChange={(e) => set({ companyName: e.target.value })} />
              <FieldError msg={fieldErrors.companyName} />
            </div>
            <div>
              <Label htmlFor="cus-e-contact">Contact person</Label>
              <Input id="cus-e-contact" value={form.contactPerson} onChange={(e) => set({ contactPerson: e.target.value })} />
              <FieldError msg={fieldErrors.contactPerson} />
            </div>
            <div>
              <Label htmlFor="cus-e-phone">Phone</Label>
              <Input id="cus-e-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
              <FieldError msg={fieldErrors.phone} />
            </div>
            <div>
              <Label htmlFor="cus-e-email">Email</Label>
              <Input id="cus-e-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
              <FieldError msg={fieldErrors.email} />
            </div>
            <div>
              <Label htmlFor="cus-e-city">City</Label>
              <Input id="cus-e-city" value={form.city} onChange={(e) => set({ city: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cus-e-address">Address</Label>
              <Input id="cus-e-address" value={form.address} onChange={(e) => set({ address: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cus-e-notes">Notes</Label>
              <Textarea id="cus-e-notes" rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="mt-3 text-xs text-muted-foreground">
        Unsaved changes are protected — navigation asks for confirmation until you save.
      </p>
    </PageShell>
  );
}
