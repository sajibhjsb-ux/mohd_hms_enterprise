"use client";

// MOHD.HMS ENTERPRISE — Finance payment-proof review queue (spec §27-§28).
//
// Self-fetching component (no props) so the Finance module can drop it into a
// tab: loads GET /api/v1/payments?status=ON_HOLD (awaiting review) and a second
// query for REJECTED history. Finance (payments.record holders) can Confirm
// (money settles — invoice + bank + ledger, same shared helper as the staff
// path), Reject (reason required) or Request info (stays on hold) per proof.
// Every action hits POST /api/v1/payments/{id}/review, then refreshes + toasts.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { StatusBadge, EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { useSession, hasPerm } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { customerLabel, fmtDate, fmtDateTime, money } from "@/lib/hms/format";
import { PERMISSIONS } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { BadgeCheck, BadgeX, CircleCheck, FileText, MessageCircleQuestion, RefreshCcw } from "lucide-react";

// ── Types (mirror GET /api/v1/payments) ──

type ReviewRow = {
  id: string;
  code: string;
  amountCents: number;
  method: string;
  status: string;
  bank: string;
  reference: string;
  note: string;
  paidAt: string;
  createdAt: string;
  proofName: string;
  proofSizeBytes: number;
  verification: string;
  reviewNote: string;
  reviewedAt: string | null;
  submittedBy: { id: string; name: string; email: string } | null;
  invoice: {
    id: string; code: string; totalCents: number; balanceCents: number; status: string;
    customer: { id: string; code: string; companyName: string; contactPerson: string };
  } | null;
};

const REJECT_PRESETS = [
  "Amount mismatch",
  "Invalid proof",
  "Transaction could not be verified",
  "Incorrect invoice",
  "Duplicate submission",
] as const;

/** Parse the verification JSON into MATCHED / MISMATCH / UNVERIFIED. */
function verificationResult(raw: string | null | undefined): string {
  if (!raw) return "UNVERIFIED";
  try {
    const v = JSON.parse(raw) as { result?: unknown };
    return typeof v.result === "string" && ["MATCHED", "MISMATCH"].includes(v.result) ? v.result : "UNVERIFIED";
  } catch {
    return "UNVERIFIED";
  }
}

function MatchBadge({ row }: { row: ReviewRow }) {
  const result = verificationResult(row.verification);
  return <StatusBadge status={result} />;
}

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

type ReviewAction = "confirm" | "reject" | "request_info";

export function PaymentReviews() {
  const { user } = useSession();
  const { toast } = useToast();
  const canRead = hasPerm(user, PERMISSIONS.payments_read);
  const canDecide = hasPerm(user, PERMISSIONS.payments_record) || hasPerm(user, PERMISSIONS.finance_manage);

  const [pending, setPending] = useState<ReviewRow[]>([]);
  const [rejected, setRejected] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // confirm → AlertDialog; reject/request_info → Dialog with reason.
  const [confirmRow, setConfirmRow] = useState<ReviewRow | null>(null);
  const [dialogAction, setDialogAction] = useState<Exclude<ReviewAction, "confirm"> | null>(null);
  const [dialogRow, setDialogRow] = useState<ReviewRow | null>(null);
  const [preset, setPreset] = useState<string>(REJECT_PRESETS[0]);
  const [freeText, setFreeText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, r] = await Promise.all([
        api.get<ReviewRow[]>(`/api/v1/payments${qs({ status: "ON_HOLD", pageSize: 200 })}`),
        api.get<ReviewRow[]>(`/api/v1/payments${qs({ status: "REJECTED", pageSize: 200 })}`),
      ]);
      setPending(p.data);
      setRejected(r.data);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canRead) load();
    else setLoading(false);
  }, [canRead, load]);

  function openDialog(action: Exclude<ReviewAction, "confirm">, row: ReviewRow) {
    setDialogAction(action);
    setDialogRow(row);
    setPreset(REJECT_PRESETS[0]);
    setFreeText("");
  }

  function closeDialog() {
    setDialogAction(null);
    setDialogRow(null);
  }

  async function runReview(row: ReviewRow, action: ReviewAction, reason?: string) {
    setBusyId(row.id);
    try {
      const res = await api.post<{ payment: ReviewRow & { invoice?: unknown } }>(
        `/api/v1/payments/${encodeURIComponent(row.id)}/review`,
        { action, ...(reason ? { reason } : {}) },
      );
      if (action === "confirm") {
        toast({
          title: `Payment ${res.data.payment?.code ?? row.code} confirmed`,
          description: "The invoice balance was settled and the bank account credited.",
        });
      } else if (action === "reject") {
        toast({ title: `Payment proof ${res.data.payment?.code ?? row.code} rejected`, description: "The customer has been notified with the reason." });
      } else {
        toast({ title: "Information requested", description: "The customer has been notified — the payment stays on hold." });
      }
      closeDialog();
      setConfirmRow(null);
      await load();
    } catch (e) {
      toast({ title: "Review action failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  function submitDialog() {
    if (!dialogRow || !dialogAction) return;
    if (dialogAction === "reject") {
      const details = freeText.trim();
      const reason = details ? `${preset} — ${details}` : preset;
      if (reason.trim().length < 5) {
        toast({ title: "Reason required", description: "Give the customer a reason of at least 5 characters.", variant: "destructive" });
        return;
      }
      void runReview(dialogRow, "reject", reason);
      return;
    }
    const note = freeText.trim();
    if (note.length < 5) {
      toast({ title: "Note required", description: "Describe what information you need (at least 5 characters).", variant: "destructive" });
      return;
    }
    void runReview(dialogRow, "request_info", note);
  }

  if (!canRead) {
    return (
      <EmptyState
        title="Finance access required"
        hint="Your role does not include payments visibility, so the payment-proof review queue is not available."
      />
    );
  }

  const proofLink = (r: ReviewRow) =>
    r.proofName ? (
      <a
        href={`/api/v1/payments/${encodeURIComponent(r.id)}/proof`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline underline-offset-2"
        title={`Download proof: ${r.proofName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <FileText className="h-3.5 w-3.5" aria-hidden /> Proof
      </a>
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );

  const baseColumns: Column<ReviewRow>[] = [
    { key: "createdAt", header: "Submitted", value: (r) => r.createdAt, render: (r) => fmtDateTime(r.createdAt), hideOnMobile: true },
    { key: "code", header: "Payment", value: (r) => r.code, render: (r) => <span className="font-medium font-mono text-xs">{r.code}</span> },
    {
      key: "invoice", header: "Invoice", value: (r) => r.invoice?.code ?? "",
      render: (r) => r.invoice ? (
        <a
          href={`/invoices/${encodeURIComponent(r.invoice.id)}`}
          className="font-mono text-xs text-primary hover:underline underline-offset-2"
          onClick={(e) => e.stopPropagation()}
          title="Open invoice detail"
        >
          {r.invoice.code}
        </a>
      ) : "—",
    },
    { key: "customer", header: "Customer", value: (r) => customerLabel(r.invoice?.customer), className: "max-w-[160px] truncate" },
    { key: "amountCents", header: "Amount", value: (r) => r.amountCents, render: (r) => <span className="tabular-nums font-medium">{money(r.amountCents)}</span> },
    { key: "method", header: "Method", value: (r) => r.method, render: (r) => <span className="whitespace-nowrap">{r.method.replaceAll("_", " ")}</span>, hideOnMobile: true },
    { key: "match", header: "Automated check", value: (r) => verificationResult(r.verification), render: (r) => <MatchBadge row={r} /> },
    { key: "reference", header: "Reference", value: (r) => r.reference, render: (r) => <span className="font-mono text-xs max-w-[140px] truncate block" title={r.reference}>{r.reference || "—"}</span>, hideOnMobile: true },
    { key: "proof", header: "Proof", value: () => "", render: proofLink, sortable: false },
  ];

  const pendingColumns: Column<ReviewRow>[] = [
    ...baseColumns,
    ...(canDecide
      ? [{
          key: "actions", header: "Actions", sortable: false,
          render: (r: ReviewRow) => (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" className="h-7 text-xs" disabled={busyId === r.id} onClick={() => setConfirmRow(r)}>
                <CircleCheck className="h-3.5 w-3.5 mr-1" /> Confirm
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === r.id} onClick={() => openDialog("reject", r)}>
                <BadgeX className="h-3.5 w-3.5 mr-1" /> Reject
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === r.id} onClick={() => openDialog("request_info", r)}>
                <MessageCircleQuestion className="h-3.5 w-3.5 mr-1" /> Info
              </Button>
            </div>
          ),
        } as Column<ReviewRow>]
      : []),
  ];

  const rejectedColumns: Column<ReviewRow>[] = [
    ...baseColumns,
    {
      key: "reviewNote", header: "Rejection reason", value: (r) => r.reviewNote,
      render: (r) => <span className="text-xs text-muted-foreground max-w-[260px] block truncate" title={r.reviewNote}>{r.reviewNote || "—"}</span>,
      hideOnMobile: true,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Customer-submitted bank transfer / BIBD / Baiduri proofs. Confirming settles the invoice balance and credits the bank account —
          nothing is marked paid until you confirm.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="shrink-0 no-print">
          <RefreshCcw className={cn("h-4 w-4 mr-1.5", loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      {error ? <ErrorState message={error} onRetry={load} /> : null}

      <Tabs defaultValue="pending">
        <TabsList className="mb-3">
          <TabsTrigger value="pending">
            On Hold{!loading ? ` (${pending.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="rejected">
            Rejected{!loading ? ` (${rejected.length})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          {loading ? (
            <LoadingState label="Loading review queue…" />
          ) : (
            <DataTable
              columns={pendingColumns}
              rows={pending}
              rowKey={(r) => r.id}
              searchPlaceholder="Search proofs…"
              exportName="payment-reviews-pending"
              emptyTitle="No payments awaiting review."
              emptyHint="Customer payment proofs appear here the moment they are submitted."
            />
          )}
        </TabsContent>

        <TabsContent value="rejected">
          {loading ? (
            <LoadingState label="Loading rejected proofs…" />
          ) : (
            <DataTable
              columns={rejectedColumns}
              rows={rejected}
              rowKey={(r) => r.id}
              searchPlaceholder="Search rejected proofs…"
              exportName="payment-reviews-rejected"
              emptyTitle="No rejected payment proofs."
              emptyHint="Rejected proofs stay here for the audit trail; customers can resubmit a corrected proof."
            />
          )}
        </TabsContent>
      </Tabs>

      {/* ── Confirm (AlertDialog) ── */}
      <AlertDialog open={!!confirmRow} onOpenChange={(open) => { if (!open) setConfirmRow(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm payment {confirmRow?.code}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This settles <strong className="text-foreground tabular-nums">{money(confirmRow?.amountCents ?? 0)}</strong>
                  {confirmRow?.invoice ? <> against invoice <span className="font-mono">{confirmRow.invoice.code}</span></> : null}{" "}
                  and credits the bank account. The invoice balance is reduced and the customer is notified.
                </p>
                {confirmRow?.invoice ? (
                  <p className="text-xs text-muted-foreground">
                    Invoice outstanding after confirmation:{" "}
                    <span className="tabular-nums">{money(Math.max(0, confirmRow.invoice.balanceCents - confirmRow.amountCents))}</span>
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">This action moves money in the ledger and cannot be undone here.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyId === confirmRow?.id}
              onClick={(e) => {
                e.preventDefault();
                if (confirmRow) void runReview(confirmRow, "confirm");
              }}
            >
              <BadgeCheck className="h-4 w-4 mr-1.5" /> Confirm payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Reject / Request info (Dialog with reason) ── */}
      <Dialog open={!!dialogAction} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogAction === "reject" ? `Reject payment proof ${dialogRow?.code ?? ""}` : `Request information — ${dialogRow?.code ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              {dialogAction === "reject"
                ? "The payment is rejected and the customer can resubmit a corrected proof. The invoice stays untouched."
                : "The payment stays on hold while the customer provides the information you ask for."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {dialogAction === "reject" ? (
              <div className="space-y-1.5">
                <Label>Reason *</Label>
                <Select value={preset} onValueChange={setPreset}>
                  <SelectTrigger aria-label="Rejection reason"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {REJECT_PRESETS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>{dialogAction === "reject" ? "Extra details (optional)" : "What do you need from the customer? *"}</Label>
              <Textarea
                rows={3}
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder={dialogAction === "reject"
                  ? "e.g. The uploaded receipt is unreadable — please rescan it."
                  : "e.g. Please confirm the exact transfer date and add the bank account last 4 digits."}
              />
            </div>
            {dialogRow ? (
              <div className="rounded-lg border bg-muted/40 p-3 text-xs space-y-1">
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Amount</span><span className="tabular-nums">{money(dialogRow.amountCents)}</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Automated check</span><Badge variant="outline" className="h-4 text-[10px] px-1.5">{verificationResult(dialogRow.verification)}</Badge></div>
                {dialogRow.invoice ? (
                  <div className="flex justify-between gap-2"><span className="text-muted-foreground">Invoice outstanding</span><span className="tabular-nums">{money(dialogRow.invoice.balanceCents)}</span></div>
                ) : null}
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Submitted</span><span>{fmtDate(dialogRow.createdAt)}</span></div>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button
              variant={dialogAction === "reject" ? "destructive" : "default"}
              disabled={busyId === dialogRow?.id}
              onClick={submitDialog}
            >
              {dialogAction === "reject" ? "Reject proof" : "Request information"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
