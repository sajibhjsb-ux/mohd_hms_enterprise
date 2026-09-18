"use client";

// MOHD.HMS ENTERPRISE — New Quotation (dedicated full page, quotations/new view).
// Replaces the former create dialog: same draft protection (formKey
// "quotation.create" kept so old drafts still restore), same refs, same payload
// to POST /api/v1/quotations, same client-side math — no popup, no new APIs.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { LineItemsEditor, TotalsPanel, formTotals } from "@/components/hms/shared/line-items-editor";
import { PERMISSIONS } from "@/lib/hms/constants";
import { money, fromCents } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ClientApiError } from "@/lib/hms/api-client";
import { FileText, Loader2, RotateCcw, Save } from "lucide-react";
import { emptyForm, emptyItem, type CustomerLite, type InventoryLite, type QuotationDetail, type QForm } from "./shared";

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

export function QuotationNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.quotations_manage);

  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [inventory, setInventory] = useState<InventoryLite[]>([]);
  const [refsLoading, setRefsLoading] = useState(false);

  // Draft protection kept verbatim from the former dialog (same formKey).
  const form = useDraft<QForm>({ formKey: "quotation.create", initial: emptyForm() });

  // ── Dirty-state wiring (central router guard + data protection) ──
  useEffect(() => {
    setPageDirty(form.dirty);
    return () => { setPageDirty(false); };
  }, [form.dirty, setPageDirty]);

  // ── References: customers + inventory (same endpoints the dialog used) ──
  useEffect(() => {
    if (!canManage || customers.length > 0) return;
    let alive = true;
    setRefsLoading(true);
    Promise.all([
      api.get<CustomerLite[]>("/api/v1/customers").catch(() => null),
      api.get<InventoryLite[]>("/api/v1/inventory").catch(() => null),
    ]).then(([c, i]) => {
      if (!alive) return;
      if (c) setCustomers(c.data);
      if (i) setInventory(i.data);
      if (!c) toast({ title: "Customers unavailable", description: "Could not load the customer list. Please retry later.", variant: "destructive" });
    }).finally(() => { if (alive) setRefsLoading(false); });
    return () => { alive = false; };
  }, [canManage, customers.length, toast]);

  // ── Line item handlers (same behaviour as the former dialog) ──

  const setItem = useCallback((index: number, patch: Partial<QForm["items"][number]>) => {
    const items = form.value.items.map((it, i) => (i === index ? { ...it, ...patch } : it));
    form.setValue({ items });
  }, [form]);

  const pickInventory = useCallback((index: number, itemId: string) => {
    const item = inventory.find((i) => i.id === itemId);
    if (!item) { setItem(index, { itemId: "" }); return; }
    setItem(index, { itemId, description: item.name, unit: item.unit, unitPrice: fromCents(item.unitCostCents) });
  }, [inventory, setItem]);

  const addItem = useCallback(() => {
    form.setValue({ items: [...form.value.items, emptyItem()] });
  }, [form]);

  const removeItem = useCallback((index: number) => {
    form.setValue({ items: form.value.items.filter((_, i) => i !== index) });
  }, [form]);

  const totals = useMemo(
    () => formTotals(form.value.items, form.value.discount, form.value.shipping),
    [form.value.items, form.value.discount, form.value.shipping]
  );
  // formTotals is imported from the shared line-items editor (server-mirroring math).

  // ── Actions ──

  function goBackToList() {
    form.saveNow(); // silent protection — never lose typed data when leaving via Back
    navigateTo("quotations");
  }

  function saveDraft() {
    form.saveNow();
    toast({ title: "Draft saved successfully", description: "You can safely leave this page and restore the draft later." });
  }

  async function createQuotation() {
    setSubmitError(null);
    if (!form.value.customerId) {
      toast({ title: "Customer required", description: "Select a customer for this quotation.", variant: "destructive" });
      return;
    }
    const validItems = form.value.items.filter((it) => it.description.trim() && (parseFloat(it.unitPrice) || 0) >= 0 && (parseFloat(it.quantity) || 0) > 0);
    if (validItems.length === 0) {
      toast({ title: "Line items required", description: "Add at least one item with a description and price.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<QuotationDetail>("/api/v1/quotations", {
        customerId: form.value.customerId,
        validUntil: form.value.validUntil || null,
        discount: parseFloat(form.value.discount) || 0,
        shipping: parseFloat(form.value.shipping) || 0,
        notes: form.value.notes,
        terms: form.value.terms,
        items: validItems.map((it) => ({
          kind: it.kind,
          itemId: it.itemId || null,
          description: it.description.trim(),
          quantity: parseFloat(it.quantity) || 0,
          unit: it.unit || undefined,
          unitPrice: parseFloat(it.unitPrice) || 0,
          discountPercent: parseFloat(it.discountPercent) || 0,
          taxPercent: parseFloat(it.taxPercent) || 0,
        })),
      });
      toast({ title: `Quotation ${res.data.code} created`, description: `Total ${money(res.data.totalCents)} — draft status.` });
      form.reset(emptyForm());
      setPageDirty(false);
      // Continue on the quotation's dedicated detail page.
      navigateTo("quotations", [res.data.id]);
    } catch (e) {
      // CRITICAL: keep every user-entered value on failure — show the error and allow retry.
      const msg = errMessage(e);
      setSubmitError(msg);
      toast({ title: "Could not create quotation", description: msg, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // ── RBAC guard ──
  if (!canManage) {
    return (
      <PageShell
        backLabel="Back to Quotations"
        backHref="#/quotations"
        crumbs={[{ label: "Quotations", href: "#/quotations" }, { label: "New Quotation" }]}
        title="New Quotation"
        description="Professional quotation with line items, totals and terms."
      >
        <EmptyState
          title="You don't have permission to create quotations"
          hint="Ask an administrator for the quotations.manage permission. Quotations shared with you remain visible in the list."
        />
      </PageShell>
    );
  }

  const createButton = (
    <Button onClick={createQuotation} disabled={busy || refsLoading}>
      {busy ? (<><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…</>) : "Create quotation"}
    </Button>
  );

  return (
    <PageShell
      backLabel="Back to Quotations"
      backHref="#/quotations"
      crumbs={[{ label: "Quotations", href: "#/quotations" }, { label: "New Quotation" }]}
      title="New Quotation"
      description="Professional quotation with line items, totals and terms."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={saveDraft} disabled={busy}>
            <Save className="h-4 w-4 mr-1.5" /> Save Draft
          </Button>
          {createButton}
        </div>
      }
    >
      {/* Draft restore banner (same draft store as the former dialog) */}
      {form.draftExists ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
          <FileText className="h-4 w-4 text-amber-600 shrink-0" />
          <span className="flex-1">An unsent draft exists from a previous session.</span>
          <Button size="sm" variant="outline" onClick={form.restore}><RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore</Button>
          <Button size="sm" variant="ghost" onClick={form.discard}>Discard</Button>
        </div>
      ) : null}

      {/* Error banner — values above are preserved for retry */}
      {submitError ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {submitError} Your entries below are kept — fix the issue and try again.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3 items-start">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-4">
          {/* Quotation details */}
          <section className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4" aria-label="Quotation details">
            <p className="text-sm font-medium">Quotation details</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Customer *</Label>
                <Select value={form.value.customerId} onValueChange={(v) => form.setValue({ customerId: v })}>
                  <SelectTrigger aria-label="Customer"><SelectValue placeholder={refsLoading ? "Loading customers…" : "Select customer"} /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.companyName} ({c.code})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Valid until</Label>
                <Input type="date" value={form.value.validUntil} onChange={(e) => form.setValue({ validUntil: e.target.value })} />
              </div>
            </div>
          </section>

          {/* Line items */}
          <section className="rounded-xl border bg-card shadow-sm p-4 sm:p-5" aria-label="Line items">
            <LineItemsEditor
              items={form.value.items}
              inventory={inventory}
              onChange={setItem}
              onPickInventory={pickInventory}
              onRemove={removeItem}
              onAdd={addItem}
            />
          </section>

          {/* Notes & terms */}
          <section className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4" aria-label="Notes and terms">
            <p className="text-sm font-medium">Notes &amp; terms</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Discount (BND)</Label><Input inputMode="decimal" value={form.value.discount} onChange={(e) => form.setValue({ discount: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Shipping (BND)</Label><Input inputMode="decimal" value={form.value.shipping} onChange={(e) => form.setValue({ shipping: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Notes</Label><Textarea rows={2} value={form.value.notes} onChange={(e) => form.setValue({ notes: e.target.value })} placeholder="Internal or customer notes" /></div>
              <div className="space-y-1.5"><Label>Terms</Label><Textarea rows={2} value={form.value.terms} onChange={(e) => form.setValue({ terms: e.target.value })} placeholder="Payment / validity terms" /></div>
            </div>
          </section>
        </div>

        {/* Side column — live totals + actions */}
        <div className="space-y-4">
          <section className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-3" aria-label="Totals">
            <p className="text-sm font-medium">Totals</p>
            <p className="text-xs text-muted-foreground">Totals are computed server-side from the line items. {form.dirty ? "Draft auto-saved locally." : ""}</p>
            <TotalsPanel totals={totals} />
          </section>

          <section className="rounded-xl border bg-card shadow-sm p-4 space-y-2" aria-label="Actions">
            <Button className="w-full" onClick={createQuotation} disabled={busy || refsLoading}>
              {busy ? (<><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…</>) : "Create quotation"}
            </Button>
            <Button variant="outline" className="w-full" onClick={saveDraft} disabled={busy}>
              <Save className="h-4 w-4 mr-1.5" /> Save Draft
            </Button>
            <Button variant="ghost" className="w-full" onClick={goBackToList} disabled={busy}>
              Back to Quotations
            </Button>
          </section>
        </div>
      </div>
    </PageShell>
  );
}
