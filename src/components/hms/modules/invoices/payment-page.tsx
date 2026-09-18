"use client";

// MOHD.HMS ENTERPRISE — Record Payment (dedicated full page, invoices/{id}/payment).
// Replaces the former nested payment dialog: same fields, same live balance /
// status preview, same validation and POST /api/v1/invoices/{id}/payments —
// no popup. Success returns to the invoice detail page.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { money, fromCents } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CircleDollarSign, Loader2 } from "lucide-react";
import { METHODS, type InvoiceDetail } from "./shared";

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

export function InvoicePaymentPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canRecord = hasPerm(user, PERMISSIONS.payments_record);

  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<InvoiceDetail>(`/api/v1/invoices/${id}`);
      setDetail(res.data);
      // Prefill with the outstanding balance once (user typing is never overwritten).
      setAmount((cur) => cur || fromCents(res.data.balanceCents));
    } catch (e) {
      setLoadError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // ── Dirty-state wiring (central router guard protects partial payment entry) ──
  useEffect(() => {
    setPageDirty(touched);
    return () => { setPageDirty(false); };
  }, [touched, setPageDirty]);

  // ── Live preview of new balance + status after payment (same math as the dialog) ──
  const payPreview = useMemo(() => {
    const cents = Math.round((parseFloat(amount) || 0) * 100);
    if (!detail || cents <= 0) return null;
    return {
      newBalanceCents: Math.max(0, detail.balanceCents - cents),
      newStatus: detail.balanceCents - cents === 0 ? "PAID" : "PARTIALLY_PAID",
    };
  }, [amount, detail]);

  function markTouched() {
    setTouched(true);
  }

  async function recordPayment() {
    if (!detail) return;
    const value = parseFloat(amount);
    if (!isFinite(value) || value <= 0) {
      toast({ title: "Invalid amount", description: "Enter a payment amount greater than 0.", variant: "destructive" });
      return;
    }
    if (Math.round(value * 100) > detail.balanceCents) {
      toast({ title: "Amount exceeds balance", description: `Outstanding balance is ${money(detail.balanceCents)}.`, variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<InvoiceDetail>(`/api/v1/invoices/${detail.id}/payments`, {
        amount: value, method, reference: reference || undefined, note: note || undefined,
      });
      toast({ title: "Payment recorded", description: `Balance now ${money(res.data.balanceCents)} — status ${res.data.status.replaceAll("_", " ").toLowerCase()}.` });
      setTouched(false);
      setPageDirty(false);
      // Back to the invoice detail page.
      navigateTo("invoices", [detail.id]);
    } catch (e) {
      toast({ title: "Payment failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const backHref = `#/invoices/${encodeURIComponent(id)}`;
  const chrome = (children: ReactNode) => (
    <PageShell
      backLabel="Back to Invoice"
      backHref={backHref}
      crumbs={[
        { label: "Invoices", href: "#/invoices" },
        { label: detail?.code ?? "Invoice", href: backHref },
        { label: "Record Payment" },
      ]}
      title="Record Payment"
      description={detail ? `Outstanding balance: ${money(detail.balanceCents)}` : "Record a customer payment against this invoice."}
    >
      {children}
    </PageShell>
  );

  // ── RBAC guard ──
  if (!canRecord) {
    return chrome(
      <EmptyState
        title="You don't have permission to record payments"
        hint="Ask an administrator for the payments.record permission."
      />
    );
  }

  if (loading && !detail) {
    return chrome(<LoadingState label="Loading invoice…" rows={3} />);
  }

  if (loadError && !detail) {
    return chrome(<ErrorState message={loadError} onRetry={load} />);
  }

  if (!detail) {
    return chrome(<EmptyState title="Invoice not found" hint="It may have been removed or the link is incorrect." />);
  }

  // Same eligibility rules as the former "Record Payment" button.
  const payable = !["DRAFT", "CANCELLED", "PAID"].includes(detail.status) && detail.balanceCents > 0;
  if (!payable) {
    return chrome(
      <EmptyState
        title="Payment cannot be recorded"
        hint={`Invoice ${detail.code} is ${detail.status.replaceAll("_", " ").toLowerCase()} with a balance of ${money(detail.balanceCents)}.`}
      />
    );
  }

  return chrome(
    <div className="grid gap-4 lg:grid-cols-3 items-start">
      {/* Main column — payment form */}
      <div className="lg:col-span-2">
        <section className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4" aria-label="Payment details">
          <p className="text-sm font-medium">Payment details</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">Amount (BND) *</Label>
              <Input
                id="pay-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => { setAmount(e.target.value); markTouched(); }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Method *</Label>
              <Select value={method} onValueChange={(v) => { setMethod(v); markTouched(); }}>
                <SelectTrigger aria-label="Method"><SelectValue /></SelectTrigger>
                <SelectContent>{METHODS.map((m) => <SelectItem key={m} value={m}>{m.replaceAll("_", " ")}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-reference">Reference</Label>
            <Input id="pay-reference" value={reference} onChange={(e) => { setReference(e.target.value); markTouched(); }} placeholder="e.g. MBB-889201" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-note">Note</Label>
            <Input id="pay-note" value={note} onChange={(e) => { setNote(e.target.value); markTouched(); }} placeholder="Optional note" />
          </div>

          {payPreview ? (
            <div className="rounded-lg bg-muted/50 border p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Payment amount</span><span className="tabular-nums">{money(Math.round((parseFloat(amount) || 0) * 100))}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">New balance</span><span className="tabular-nums font-medium">{money(payPreview.newBalanceCents)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Status after payment</span><StatusBadge status={payPreview.newStatus} /></div>
            </div>
          ) : null}
        </section>
      </div>

      {/* Side column — invoice summary + actions */}
      <div className="space-y-4">
        <section className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-3" aria-label="Invoice summary">
          <p className="text-sm font-medium">Invoice summary</p>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between gap-2"><span className="text-muted-foreground">Code</span><span className="font-mono">{detail.code}</span></div>
            <div className="flex justify-between gap-2"><span className="text-muted-foreground">Customer</span><span className="text-right max-w-[60%] truncate" title={detail.customer?.companyName}>{detail.customer?.companyName ?? "—"}</span></div>
            <div className="flex justify-between gap-2"><span className="text-muted-foreground">Total</span><span className="tabular-nums">{money(detail.totalCents)}</span></div>
            <div className="flex justify-between gap-2"><span className="text-muted-foreground">Paid</span><span className="tabular-nums text-emerald-700">-{money(detail.paidCents)}</span></div>
            <div className="flex justify-between gap-2 font-semibold"><span>Balance due</span><span className="tabular-nums">{money(detail.balanceCents)}</span></div>
          </div>
        </section>

        <section className="rounded-xl border bg-card shadow-sm p-4 space-y-2" aria-label="Actions">
          <Button className="w-full" onClick={recordPayment} disabled={busy}>
            {busy ? (<><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Recording…</>) : (<><CircleDollarSign className="h-4 w-4 mr-1.5" /> Record payment</>)}
          </Button>
          <Button variant="outline" className="w-full" onClick={() => navigateTo("invoices", [detail.id])} disabled={busy}>
            Back to Invoice
          </Button>
        </section>
      </div>
    </div>
  );
}
