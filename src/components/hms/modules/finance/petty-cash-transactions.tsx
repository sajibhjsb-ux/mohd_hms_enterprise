"use client";

// MOHD.HMS ENTERPRISE — Petty Cash ▸ Transactions sub-tab (spec §34-§38).
//
// Server-side filters (fund / type / status / month), submit-for-approval
// dialog (creates PENDING, then offers an optional receipt upload), inline
// approve / reject for pending rows and authorized receipt downloads.
// The UI is honest: a new transaction NEVER changes any balance — the toast
// says "awaiting Finance approval" because that is exactly what happened.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { LoadingState, EmptyState, ErrorState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { fmtDate, money } from "@/lib/hms/format";
import { Check, X, Plus, Paperclip } from "lucide-react";
import {
  humanErrorMessage, receiptUrl, FundChip, ReceiptChip, SignedAmount, TxTypeBadge,
  TX_TYPES, TX_TYPE_LABELS, type PCFund, type PCTransaction, type PCStaffOption,
} from "./petty-cash-shared";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export function PettyCashTransactionsSubTab({
  canManage, currentUserId, isAdmin, onChanged,
}: {
  canManage: boolean;
  currentUserId: string;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [rows, setRows] = useState<PCTransaction[]>([]);
  const [funds, setFunds] = useState<PCFund[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Server-side filters
  const [fundId, setFundId] = useState("all");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [month, setMonth] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [rejectTx, setRejectTx] = useState<PCTransaction | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<string | null>(null);

  const loadRows = useCallback(async (f: string, t: string, s: string, m: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<PCTransaction[]>(`/api/v1/finance/petty-cash/transactions${qs({
        pageSize: 200,
        fundId: f !== "all" ? f : undefined,
        type: t !== "all" ? t : undefined,
        status: s !== "all" ? s : undefined,
        month: m || undefined,
      })}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFunds = useCallback(async () => {
    try {
      const res = await api.get<PCFund[]>("/api/v1/finance/petty-cash/funds?pageSize=200");
      setFunds(res.data);
    } catch {
      /* filter picker degrades — the list still renders */
    }
  }, []);

  useEffect(() => {
    loadRows(fundId, type, status, month);
    loadFunds();
  }, []);

  function applyFilters(f: string, t: string, s: string, m: string) {
    setFundId(f); setType(t); setStatus(s); setMonth(m);
    void loadRows(f, t, s, m);
  }

  async function transition(tx: PCTransaction, action: "approve") {
    setBusyId(tx.id);
    try {
      const res = await api.post<PCTransaction>(`/api/v1/finance/petty-cash/transactions/${tx.id}/transition`, { action });
      toast({
        title: `Transaction ${res.data.code} approved`,
        description: `Fund balance is now ${money(res.data.balanceAfterCents)}.`,
      });
      await loadRows(fundId, type, status, month);
      onChanged();
    } catch (e) {
      toast({ title: "Approval failed", description: humanErrorMessage(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function uploadReceipt(txId: string, file: File) {
    const fd = new FormData();
    fd.set("file", file);
    const res = await fetch(receiptUrl(txId), { method: "POST", body: fd, credentials: "same-origin" });
    const payload = (await res.json().catch(() => null)) as { ok: boolean; error?: { message: string } } | null;
    if (!res.ok || !payload || payload.ok === false) {
      throw new ClientApiError(payload?.error?.message ?? `Upload failed (${res.status}).`, "RECEIPT_UPLOAD_FAILED", res.status);
    }
  }

  function pickReceipt(txId: string) {
    uploadTargetRef.current = txId;
    uploadInputRef.current?.click();
  }

  async function onReceiptChosen(file: File | undefined) {
    const txId = uploadTargetRef.current;
    if (!file || !txId) return;
    setBusyId(txId);
    try {
      await uploadReceipt(txId, file);
      toast({ title: "Receipt attached", description: "The receipt is stored with the transaction." });
      await loadRows(fundId, type, status, month);
      onChanged();
    } catch (e) {
      toast({ title: "Receipt upload failed", description: humanErrorMessage(e), variant: "destructive" });
    } finally {
      setBusyId(null);
      uploadTargetRef.current = null;
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  const columns: Column<PCTransaction>[] = [
    { key: "txDate", header: "Date", value: (r) => r.txDate, render: (r) => fmtDate(r.txDate), hideOnMobile: true },
    { key: "code", header: "Code", value: (r) => r.code, render: (r) => <span className="font-medium font-mono text-xs">{r.code}</span> },
    { key: "fund", header: "Fund", value: (r) => `${r.fund.code} ${r.fund.name}`, render: (r) => <FundChip fund={r.fund} />, hideOnMobile: true },
    { key: "type", header: "Type", value: (r) => r.type, render: (r) => <TxTypeBadge type={r.type} /> },
    { key: "category", header: "Category", value: (r) => r.category, hideOnMobile: true },
    { key: "description", header: "Description", value: (r) => r.description, className: "max-w-[200px] truncate" },
    { key: "requester", header: "Requester", value: (r) => r.requesterName, render: (r) => r.requesterName || "—", hideOnMobile: true },
    { key: "reference", header: "Reference", value: (r) => r.reference, render: (r) => r.reference || "—", hideOnMobile: true },
    {
      key: "amountCents", header: "Amount", value: (r) => r.amountCents,
      render: (r) => <SignedAmount direction={r.direction} cents={r.amountCents} />,
    },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <span title={r.reviewNote || undefined}><StatusBadge status={r.status} /></span> },
    { key: "receipt", header: "Receipt", sortable: false, render: (r) => <ReceiptChip tx={r} /> },
    ...(canManage ? [{
      key: "actions", header: "Actions", sortable: false,
      render: (r: PCTransaction) => (
        <div className="flex items-center gap-1.5">
          {r.status === "PENDING" && (r.createdById !== currentUserId || isAdmin) ? (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === r.id} onClick={() => void transition(r, "approve")}>
              <Check className="h-3.5 w-3.5 mr-1" /> Approve
            </Button>
          ) : null}
          {r.status === "PENDING" && (r.createdById !== currentUserId || isAdmin) ? (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === r.id} onClick={() => setRejectTx(r)}>
              <X className="h-3.5 w-3.5 mr-1" /> Reject
            </Button>
          ) : null}
          {r.status === "PENDING" ? (
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busyId === r.id} onClick={() => pickReceipt(r.id)}>
              <Paperclip className="h-3.5 w-3.5 mr-1" /> {r.receiptName ? "Replace" : "Receipt"}
            </Button>
          ) : null}
        </div>
      ),
    } as Column<PCTransaction>] : []),
  ];

  return (
    <div className="space-y-4 min-w-0">
      <input
        ref={uploadInputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        className="hidden"
        onChange={(e) => void onReceiptChosen(e.target.files?.[0])}
        aria-hidden
      />

      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 min-w-0">
          <Select value={fundId} onValueChange={(v) => applyFilters(v, type, status, month)}>
            <SelectTrigger className="w-full" aria-label="Filter by fund"><SelectValue placeholder="All funds" /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">All funds</SelectItem>
              {funds.map((f) => <SelectItem key={f.id} value={f.id}>{f.code} · {f.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={(v) => applyFilters(fundId, v, status, month)}>
            <SelectTrigger className="w-full" aria-label="Filter by type"><SelectValue placeholder="All types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {TX_TYPES.map((t) => <SelectItem key={t} value={t}>{TX_TYPE_LABELS[t]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => applyFilters(fundId, type, v, month)}>
            <SelectTrigger className="w-full" aria-label="Filter by status"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="month"
            aria-label="Filter by month"
            className="w-full"
            value={month}
            onChange={(e) => applyFilters(fundId, type, status, e.target.value)}
          />
        </div>
        <div className="flex gap-2 justify-end">
          {(fundId !== "all" || type !== "all" || status !== "all" || month) ? (
            <Button variant="ghost" size="sm" onClick={() => applyFilters("all", "all", "all", "")}>Clear</Button>
          ) : null}
          {canManage ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> New transaction
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => loadRows(fundId, type, status, month)} />
      ) : loading ? (
        <LoadingState label="Loading transactions…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No transactions found"
          hint={canManage ? "Submit a cash movement for approval — the balance moves only when it is approved." : "Transactions appear here once submitted."}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          searchPlaceholder="Search transactions…"
          exportName="petty-cash-transactions"
          emptyTitle="No transactions match"
        />
      )}

      <NewTransactionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onDone={async () => { await loadRows(fundId, type, status, month); onChanged(); }}
      />

      <RejectDialog
        tx={rejectTx}
        onOpenChange={(o) => { if (!o) setRejectTx(null); }}
        onDone={async () => { setRejectTx(null); await loadRows(fundId, type, status, month); onChanged(); }}
      />
    </div>
  );
}

// ── New transaction dialog (form → optional receipt) ──

function NewTransactionDialog({
  open, onOpenChange, onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState<"form" | "receipt">("form");
  const [created, setCreated] = useState<PCTransaction | null>(null);

  const [funds, setFunds] = useState<PCFund[]>([]);
  const [staff, setStaff] = useState<PCStaffOption[]>([]);
  const [fundId, setFundId] = useState("");
  const [type, setType] = useState<string>("EXPENSE");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [txDate, setTxDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [requesterId, setRequesterId] = useState("me");
  const [reference, setReference] = useState("");
  const [direction, setDirection] = useState("OUT");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep("form");
    setCreated(null);
    setType("EXPENSE");
    setAmount("");
    setCategory("");
    setDescription("");
    setTxDate(new Date().toISOString().slice(0, 10));
    setRequesterId("me");
    setReference("");
    setDirection("OUT");
    setFile(null);
    let alive = true;
    api.get<PCFund[]>("/api/v1/finance/petty-cash/funds?pageSize=200")
      .then((res) => {
        if (!alive) return;
        const active = res.data.filter((f) => f.status === "ACTIVE");
        setFunds(active);
        setFundId((prev) => (active.some((f) => f.id === prev) ? prev : active[0]?.id ?? ""));
      })
      .catch(() => { /* server validates anyway */ });
    api.get<PCStaffOption[]>("/api/v1/finance/petty-cash/custodians")
      .then((res) => { if (alive) setStaff(res.data); })
      .catch(() => { /* optional picker */ });
    return () => { alive = false; };
  }, [open]);

  async function submitTx() {
    if (!fundId) {
      toast({ title: "Select a fund", description: "Pick the petty cash fund this movement belongs to.", variant: "destructive" });
      return;
    }
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      toast({ title: "Amount required", description: "Enter an amount greater than 0.", variant: "destructive" });
      return;
    }
    if ((type === "EXPENSE" || type === "REIMBURSEMENT") && !description.trim()) {
      toast({ title: "Description required", description: "EXPENSE and REIMBURSEMENT transactions need a description.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<PCTransaction>("/api/v1/finance/petty-cash/transactions", {
        fundId,
        type,
        amount: amt,
        category: category.trim() || undefined,
        description: description.trim(),
        txDate: txDate ? new Date(`${txDate}T00:00:00`).toISOString() : undefined,
        requesterId: requesterId !== "me" && requesterId !== "none" ? requesterId : undefined,
        reference: reference.trim() || undefined,
        direction: type === "ADJUSTMENT" ? direction : undefined,
      });
      setCreated(res.data);
      setStep("receipt");
      // Honest feedback (§49): nothing has been paid out yet — approval pending.
      toast({
        title: "Transaction submitted — awaiting Finance approval.",
        description: `${res.data.code} · ${money(res.data.amountCents)} — the fund balance moves only when it is approved.`,
      });
    } catch (e) {
      toast({ title: "Could not submit transaction", description: humanErrorMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function attachReceipt() {
    if (!created || !file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch(receiptUrl(created.id), { method: "POST", body: fd, credentials: "same-origin" });
      const payload = (await res.json().catch(() => null)) as { ok: boolean; error?: { message: string } } | null;
      if (!res.ok || !payload || payload.ok === false) {
        throw new Error(payload?.error?.message ?? `Upload failed (${res.status}).`);
      }
      toast({ title: "Receipt attached", description: `${file.name} stored with ${created.code}.` });
      await onDone();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Receipt upload failed", description: humanErrorMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        {step === "form" ? (
          <>
            <DialogHeader>
              <DialogTitle>New petty cash transaction</DialogTitle>
              <DialogDescription>
                Submitted as PENDING — a Finance approver must approve before the fund balance moves.
                {type === "ADJUSTMENT" ? " Adjustments let you pick the direction (IN or OUT)." : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="pct-fund">Fund</Label>
                <Select value={fundId} onValueChange={setFundId}>
                  <SelectTrigger id="pct-fund"><SelectValue placeholder="Select fund" /></SelectTrigger>
                  <SelectContent className="max-h-60">
                    {funds.map((f) => (
                      <SelectItem key={f.id} value={f.id}>{f.code} · {f.name} — {money(f.currentBalanceCents)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pct-type">Type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger id="pct-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TX_TYPES.map((t) => <SelectItem key={t} value={t}>{TX_TYPE_LABELS[t]}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {type === "CASH_IN" || type === "TOP_UP" ? "Money into the fund (IN)." : type === "ADJUSTMENT" ? "Direction chosen below." : "Money out of the fund (OUT)."}
                </p>
              </div>

              {type === "ADJUSTMENT" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="pct-direction">Direction</Label>
                  <Select value={direction} onValueChange={setDirection}>
                    <SelectTrigger id="pct-direction"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OUT">OUT — decrease fund</SelectItem>
                      <SelectItem value="IN">IN — increase fund</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="pct-amount">Amount (BND)</Label>
                  <Input id="pct-amount" type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </div>
              )}
              {type === "ADJUSTMENT" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="pct-amount2">Amount (BND)</Label>
                  <Input id="pct-amount2" type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="pct-category">Category</Label>
                <Input id="pct-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. TRANSPORT" maxLength={80} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pct-date">Date</Label>
                <Input id="pct-date" type="date" value={txDate} onChange={(e) => setTxDate(e.target.value)} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pct-requester">Requester</Label>
                <Select value={requesterId} onValueChange={setRequesterId}>
                  <SelectTrigger id="pct-requester"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-60">
                    <SelectItem value="me">Myself</SelectItem>
                    <SelectItem value="none">Unattributed</SelectItem>
                    {staff.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="pct-desc">
                  Description{type === "EXPENSE" || type === "REIMBURSEMENT" ? " (required)" : ""}
                </Label>
                <Textarea id="pct-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="What was the cash used for?" />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="pct-ref">Reference</Label>
                <Input id="pct-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder="Optional — receipt no., voucher, invoice…" />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button onClick={() => void submitTx()} disabled={busy}>
                <Plus className="h-4 w-4 mr-1.5" /> Submit for approval
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Attach a receipt (optional)</DialogTitle>
              <DialogDescription>
                {created ? `${created.code} is pending approval with ${money(created.amountCents)} (${created.direction}).` : ""}
                {" "}You can also attach or replace the receipt later while it is still pending.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label htmlFor="pct-receipt">Receipt file (PDF, JPG or PNG · max 10 MB)</Label>
              <Input
                id="pct-receipt"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? <p className="text-xs text-muted-foreground truncate">{file.name} · {(file.size / 1024).toFixed(0)} KB</p> : null}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={async () => { await onDone(); onOpenChange(false); }} disabled={busy}>
                Skip for now
              </Button>
              <Button onClick={() => void attachReceipt()} disabled={busy || !file}>
                <Paperclip className="h-4 w-4 mr-1.5" /> Attach receipt
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Reject dialog (note required, ≥ 5 chars) ──

function RejectDialog({
  tx, onOpenChange, onDone,
}: {
  tx: PCTransaction | null;
  onOpenChange: (o: boolean) => void;
  onDone: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (tx) setNote("");
  }, [tx]);

  async function submit() {
    if (!tx) return;
    if (note.trim().length < 5) {
      toast({ title: "Review note required", description: "Give a reason of at least 5 characters so the requester knows why.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<PCTransaction>(`/api/v1/finance/petty-cash/transactions/${tx.id}/transition`, { action: "reject", note: note.trim() });
      toast({ title: `Transaction ${res.data.code} rejected`, description: "The fund balance was not affected." });
      await onDone();
    } catch (e) {
      toast({ title: "Rejection failed", description: humanErrorMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={tx !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject {tx?.code}</DialogTitle>
          <DialogDescription>
            {tx ? `${TX_TYPE_LABELS[tx.type] ?? tx.type} · ${money(tx.amountCents)} — rejected transactions never touch the fund balance.` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="pct-reject-note">Reason (required)</Label>
          <Textarea id="pct-reject-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Why is this transaction being rejected?" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={busy}>
            <X className="h-4 w-4 mr-1.5" /> Reject transaction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
