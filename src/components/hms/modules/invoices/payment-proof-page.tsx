"use client";

// MOHD.HMS ENTERPRISE — Submit Payment Proof (dedicated full page, invoices/{id}/proof).
// Customer payment-proof workflow (spec §20-§26): the customer uploads a bank
// transfer / BIBD / Baiduri proof for their own invoice. The payment is
// recorded with status ON_HOLD — NEVER auto-PAID (§26); the automated amount
// check compares the submitted amount against the outstanding balance and the
// honest result (matched / mismatch) is surfaced in the success toast.
// Finance confirms or rejects the proof from the Finance review queue.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { customerLabel, fmtDate, fromCents, money } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { FileText, Loader2, Paperclip, UploadCloud, X } from "lucide-react";
import { parseVerification, PROOF_METHODS, type InvoiceDetail } from "./shared";

const PROOF_METHOD_LABELS: Record<string, string> = {
  BANK_TRANSFER: "Bank Transfer",
  BIBD: "BIBD",
  BAIDURI: "Baiduri",
};

const MAX_PROOF_BYTES = 10 * 1024 * 1024; // 10 MB — same limit the API enforces
const ALLOWED_PROOF_EXT = new Set(["pdf", "jpg", "jpeg", "png"]);

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

type ProofSubmitResponse = {
  payment: { id: string; code: string; status: string; verification: string; amountCents: number };
};

export function InvoicePaymentProofPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);

  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [paidAt, setPaidAt] = useState("");
  const [bank, setBank] = useState("");
  const [reference, setReference] = useState("");
  const [remarks, setRemarks] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<InvoiceDetail>(`/api/v1/invoices/${id}`);
      setDetail(res.data);
      // Prefill with the outstanding balance once (user typing is never overwritten).
      setAmount((cur) => cur || fromCents(res.data.balanceCents));
      setPaidAt((cur) => cur || new Date().toISOString().slice(0, 10));
    } catch (e) {
      setLoadError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // ── Dirty-state wiring (central router guard protects a partially entered proof) ──
  useEffect(() => {
    setPageDirty(touched);
    return () => { setPageDirty(false); };
  }, [touched, setPageDirty]);

  function pickFile(f: File | null) {
    setTouched(true);
    if (!f) { setFile(null); return; }
    const ext = (f.name.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED_PROOF_EXT.has(ext)) {
      toast({ title: "Unsupported file type", description: "Upload the bank proof as PDF, JPG or PNG.", variant: "destructive" });
      return;
    }
    if (f.size > MAX_PROOF_BYTES) {
      toast({ title: "File too large", description: `The proof must be 10 MB or smaller (selected: ${humanSize(f.size)}).`, variant: "destructive" });
      return;
    }
    if (f.size === 0) {
      toast({ title: "Empty file", description: "The selected file has no content.", variant: "destructive" });
      return;
    }
    setFile(f);
  }

  async function submitProof() {
    if (!detail) return;
    const value = parseFloat(amount);
    if (!isFinite(value) || value <= 0) {
      toast({ title: "Invalid amount", description: "Enter the amount you actually paid (greater than 0).", variant: "destructive" });
      return;
    }
    if (Math.round(value * 100) > detail.balanceCents) {
      toast({ title: "Amount exceeds balance", description: `The outstanding balance is ${money(detail.balanceCents)}.`, variant: "destructive" });
      return;
    }
    if (reference.trim().length < 3) {
      toast({ title: "Transaction reference required", description: "Enter the transaction reference from your bank so Finance can verify the payment.", variant: "destructive" });
      return;
    }
    if (!file) {
      toast({ title: "Proof file required", description: "Attach your bank proof (PDF, JPG or PNG, max 10 MB).", variant: "destructive" });
      return;
    }

    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("amount", amount.trim());
      fd.set("method", method);
      if (paidAt) fd.set("paidAt", new Date(paidAt).toISOString());
      if (bank.trim()) fd.set("bank", bank.trim());
      fd.set("reference", reference.trim());
      if (remarks.trim()) fd.set("note", remarks.trim());
      fd.set("file", file);

      const res = await fetch(`/api/v1/invoices/${encodeURIComponent(detail.id)}/payments/proof`, {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok: true; data: ProofSubmitResponse }
        | { ok: false; error: { message: string } }
        | null;
      if (!res.ok || !payload || payload.ok === false) {
        const message = payload && payload.ok === false ? payload.error.message : `Upload failed (${res.status}).`;
        throw new ClientApiError(message, "PROOF_UPLOAD_FAILED", res.status);
      }

      // Honest result (§46): distinguish the automated amount check outcome.
      const verification = parseVerification(payload.data.payment.verification);
      const matched = verification?.result === "MATCHED";
      toast({
        title: "Payment proof received — awaiting Finance confirmation.",
        description: matched
          ? "Amount matched — Finance review required. Your invoice is not marked as paid until Finance confirms."
          : "Amount mismatch flagged for Finance review. Your invoice is not marked as paid until Finance confirms.",
        variant: matched ? "default" : "destructive",
      });
      setTouched(false);
      setPageDirty(false);
      navigateTo("invoices", [detail.id]);
    } catch (e) {
      toast({ title: "Submission failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const backHref = `/invoices/${encodeURIComponent(id)}`;
  const chrome = (children: ReactNode) => (
    <PageShell
      backLabel="Back to Invoice"
      backHref={backHref}
      crumbs={[
        { label: "Invoices", href: "/invoices" },
        { label: detail?.code ?? "Invoice", href: backHref },
        { label: "Submit Payment Proof" },
      ]}
      title="Submit Payment Proof"
      description={detail ? `Outstanding balance: ${money(detail.balanceCents)}` : "Upload your bank payment proof for Finance to confirm."}
    >
      {children}
    </PageShell>
  );

  // ── RBAC guard (mirrors the API: own-customer portal user or SUPER_ADMIN/ADMIN) ──
  const allowed = user?.role === "CUSTOMER" ? !!user.customerId : !!user && ["SUPER_ADMIN", "ADMIN"].includes(user.role);
  if (!allowed) {
    return chrome(
      <EmptyState
        title="Payment proofs are submitted by the customer"
        hint="Only the customer's portal account (or an administrator) can submit a payment proof for this invoice."
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

  const submittable = ["SENT", "PARTIALLY_PAID", "OVERDUE"].includes(detail.status) && detail.balanceCents > 0;
  if (!submittable) {
    return chrome(
      <EmptyState
        title="Payment proof cannot be submitted"
        hint={`Invoice ${detail.code} is ${detail.status.replaceAll("_", " ").toLowerCase()} with a balance of ${money(detail.balanceCents)}. Proofs can be submitted while an invoice is sent, partially paid or overdue with an outstanding balance.`}
      />
    );
  }

  const submittedCents = Math.round((parseFloat(amount) || 0) * 100);
  const matchesBalance = submittedCents === detail.balanceCents;

  return chrome(
    <div className="grid gap-4 lg:grid-cols-3 items-start">
      {/* Main column — proof form */}
      <div className="lg:col-span-2">
        <section className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4" aria-label="Payment proof details">
          <p className="text-sm font-medium">Payment details</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="proof-amount">Amount paid (BND) *</Label>
              <Input
                id="proof-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setTouched(true); }}
              />
              {submittedCents > 0 ? (
                <p className={`text-xs ${matchesBalance ? "text-muted-foreground" : "text-amber-600"}`}>
                  {matchesBalance
                    ? "Amount matches the outstanding balance."
                    : `Does not match the outstanding balance (${money(detail.balanceCents)}) — Finance will review.`}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label>Payment method *</Label>
              <Select value={method} onValueChange={(v) => { setMethod(v); setTouched(true); }}>
                <SelectTrigger aria-label="Payment method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROOF_METHODS.map((m) => <SelectItem key={m} value={m}>{PROOF_METHOD_LABELS[m]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proof-date">Payment date *</Label>
              <Input
                id="proof-date"
                type="date"
                value={paidAt}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => { setPaidAt(e.target.value); setTouched(true); }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proof-bank">Bank name</Label>
              <Input id="proof-bank" value={bank} onChange={(e) => { setBank(e.target.value); setTouched(true); }} placeholder="e.g. Bank Islam Brunei" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proof-reference">Transaction reference *</Label>
            <Input
              id="proof-reference"
              value={reference}
              onChange={(e) => { setReference(e.target.value); setTouched(true); }}
              placeholder="e.g. BIBD-20250118-99812 (from your bank receipt)"
              required
              minLength={3}
            />
            <p className="text-xs text-muted-foreground">The transaction reference lets Finance verify your payment with the bank.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proof-remarks">Remarks</Label>
            <Textarea id="proof-remarks" rows={2} value={remarks} onChange={(e) => { setRemarks(e.target.value); setTouched(true); }} placeholder="Anything Finance should know (optional)" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="proof-file">Proof document * (PDF, JPG or PNG — max 10 MB)</Label>
            <input
              ref={fileRef}
              id="proof-file"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/15 cursor-pointer"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs w-fit max-w-full">
                <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate max-w-[220px] sm:max-w-[360px]" title={file.name}>{file.name}</span>
                <Badge variant="outline" className="shrink-0">{humanSize(file.size)}</Badge>
                <button
                  type="button"
                  aria-label="Remove selected file"
                  className="rounded-full p-0.5 hover:bg-accent shrink-0"
                  onClick={() => { setFile(null); setTouched(true); if (fileRef.current) fileRef.current.value = ""; }}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ) : null}
          </div>

          <div className="rounded-lg bg-muted/50 border p-3 text-xs text-muted-foreground">
            Your payment is <strong className="text-foreground font-medium">not applied to the invoice immediately</strong>: it is
            placed on hold and confirmed by Finance after verification. Keep the transfer receipt until then.
          </div>
        </section>
      </div>

      {/* Side column — invoice summary + actions */}
      <div className="space-y-4">
        <section className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-3" aria-label="Invoice summary">
          <p className="text-sm font-medium">Invoice summary</p>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between gap-2"><span className="text-muted-foreground">Code</span><span className="font-mono">{detail.code}</span></div>
            <div className="flex justify-between gap-2"><span className="text-muted-foreground">Customer</span><span className="text-right max-w-[60%] truncate" title={detail.customer ? customerLabel(detail.customer) : undefined}>{customerLabel(detail.customer)}</span></div>
            <div className="flex justify-between gap-2"><span className="text-muted-foreground">Issued</span><span>{fmtDate(detail.invoiceDate)}</span></div>
            <div className="flex justify-between gap-2"><span className="text-muted-foreground">Total</span><span className="tabular-nums">{money(detail.totalCents)}</span></div>
            <div className="flex justify-between gap-2"><span className="text-muted-foreground">Paid</span><span className="tabular-nums text-emerald-700">-{money(detail.paidCents)}</span></div>
            <div className="flex justify-between gap-2 font-semibold"><span>Outstanding balance</span><span className="tabular-nums">{money(detail.balanceCents)}</span></div>
          </div>
        </section>

        <section className="rounded-xl border bg-card shadow-sm p-4 space-y-2" aria-label="Actions">
          <Button className="w-full" onClick={submitProof} disabled={busy}>
            {busy ? (<><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Uploading…</>) : (<><UploadCloud className="h-4 w-4 mr-1.5" /> Submit payment proof</>)}
          </Button>
          <Button variant="outline" className="w-full" onClick={() => navigateTo("invoices", [detail.id])} disabled={busy}>
            Back to Invoice
          </Button>
          {file ? (
            <p className="text-[11px] text-muted-foreground text-center flex items-center justify-center gap-1">
              <FileText className="h-3 w-3" aria-hidden /> {file.name} ({humanSize(file.size)})
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
