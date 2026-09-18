"use client";

// MOHD.HMS ENTERPRISE — dedicated New Customer page (customers/new view).
// Replaces the former "New customer" dialog. Same API (POST /api/v1/customers),
// same RBAC, same draft architecture — no popup.
//
// Draft contract: the persisted draft (formKey "customer.create") NEVER stores
// secrets — the portal password lives in transient state outside the draft.

import { useEffect, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyRound, Loader2, RotateCcw, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type CustomerCreated = {
  id: string;
  code: string;
  companyName: string;
  portalUser: { id: string; email: string } | null;
};

// The DRAFT never stores secrets (see use-draft contract) — portalPassword is
// kept in transient state outside the persisted draft.
type FormState = {
  companyName: string; contactPerson: string; email: string; phone: string;
  address: string; city: string; notes: string; portalEmail: string;
};

const EMPTY_FORM: FormState = {
  companyName: "", contactPerson: "", email: "", phone: "",
  address: "", city: "", notes: "", portalEmail: "",
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

// ── Page ──

export function CustomerNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canCreate = hasPerm(user, PERMISSIONS.customers_create);

  // Draft protection (kept from the dialog era) — portal password stays transient.
  const draft = useDraft<FormState>({ formKey: "customer.create", initial: EMPTY_FORM });
  const [portalPassword, setPortalPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  // ── Dirty-state wiring (central router guard + data protection) ──
  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  async function submitCreate() {
    setSaving(true);
    setFieldErrors({});
    try {
      const res = await api.post<CustomerCreated>("/api/v1/customers", {
        companyName: draft.value.companyName,
        contactPerson: draft.value.contactPerson,
        email: draft.value.email,
        phone: draft.value.phone,
        address: draft.value.address || undefined,
        city: draft.value.city || undefined,
        notes: draft.value.notes || undefined,
        portalEmail: draft.value.portalEmail || undefined,
        portalPassword: portalPassword || undefined,
      });
      toast({
        title: "Customer created",
        description: `${res.data.companyName} (${res.data.code})${res.data.portalUser ? " — portal account ready" : ""}.`,
      });
      draft.reset(EMPTY_FORM);
      setPortalPassword("");
      setPageDirty(false);
      // Continue on the customer's dedicated detail page.
      navigateTo("customers", [res.data.id]);
    } catch (e) {
      // Keep every user-entered value on failure — show the error and allow retry.
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not create customer", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canCreate) {
    return (
      <PageShell
        backLabel="Back to Customers"
        backHref="#/customers"
        crumbs={[{ label: "Customers", href: "#/customers" }, { label: "New Customer" }]}
        title="New Customer"
      >
        <EmptyState
          title="You don't have permission to create customers"
          hint="Customer creation is limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const createButton = (
    <Button onClick={submitCreate} disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1.5" />}
      {saving ? "Creating…" : "Create customer"}
    </Button>
  );

  return (
    <PageShell
      backLabel="Back to Customers"
      backHref="#/customers"
      crumbs={[{ label: "Customers", href: "#/customers" }, { label: "New Customer" }]}
      title="New Customer"
      description="Code is generated automatically. Optionally provision a portal login."
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{createButton}</div>}
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
          <CardTitle className="text-base">Customer information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Label htmlFor="cus-name">Company name *</Label>
              <Input id="cus-name" value={draft.value.companyName} onChange={(e) => draft.setValue({ companyName: e.target.value })} placeholder="e.g. Metro Tower Facilities" />
              <FieldError msg={fieldErrors.companyName} />
            </div>
            <div>
              <Label htmlFor="cus-contact">Contact person *</Label>
              <Input id="cus-contact" value={draft.value.contactPerson} onChange={(e) => draft.setValue({ contactPerson: e.target.value })} placeholder="Full name" />
              <FieldError msg={fieldErrors.contactPerson} />
            </div>
            <div>
              <Label htmlFor="cus-phone">Phone *</Label>
              <Input id="cus-phone" value={draft.value.phone} onChange={(e) => draft.setValue({ phone: e.target.value })} placeholder="+60 3-…" />
              <FieldError msg={fieldErrors.phone} />
            </div>
            <div>
              <Label htmlFor="cus-email">Email *</Label>
              <Input id="cus-email" type="email" value={draft.value.email} onChange={(e) => draft.setValue({ email: e.target.value })} placeholder="contact@company.my" />
              <FieldError msg={fieldErrors.email} />
            </div>
            <div>
              <Label htmlFor="cus-city">City</Label>
              <Input id="cus-city" value={draft.value.city} onChange={(e) => draft.setValue({ city: e.target.value })} placeholder="Kuala Lumpur" />
              <FieldError msg={fieldErrors.city} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cus-address">Address</Label>
              <Input id="cus-address" value={draft.value.address} onChange={(e) => draft.setValue({ address: e.target.value })} placeholder="Street, building, postcode" />
              <FieldError msg={fieldErrors.address} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cus-notes">Notes</Label>
              <Textarea id="cus-notes" rows={2} value={draft.value.notes} onChange={(e) => draft.setValue({ notes: e.target.value })} placeholder="Internal notes (optional)" />
              <FieldError msg={fieldErrors.notes} />
            </div>

            <div className="sm:col-span-2 rounded-lg border bg-muted/40 p-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> CUSTOMER PORTAL ACCESS (OPTIONAL)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="cus-portal-email">Portal email</Label>
                  <Input id="cus-portal-email" type="email" value={draft.value.portalEmail} onChange={(e) => draft.setValue({ portalEmail: e.target.value })} placeholder="portal@company.my" />
                  <FieldError msg={fieldErrors.portalEmail} />
                </div>
                <div>
                  <Label htmlFor="cus-portal-pw">Portal password</Label>
                  <Input id="cus-portal-pw" type="text" autoComplete="off" value={portalPassword} onChange={(e) => setPortalPassword(e.target.value)} placeholder="Min 8 chars, letters + numbers" />
                  <FieldError msg={fieldErrors.portalPassword} />
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Autosave hint */}
      <p className="mt-3 text-xs text-muted-foreground">
        {draft.dirty
          ? "Draft auto-saves as you type — safe to leave and restore later. The portal password is never saved into the draft."
          : "Tip: entries auto-save as a draft while you type."}
      </p>

      {/* Sticky mobile action bar */}
      <div className={cn("sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print")}>
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3">
          <Button className="w-full" onClick={submitCreate} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1.5" />}
            {saving ? "Creating…" : "Create customer"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
