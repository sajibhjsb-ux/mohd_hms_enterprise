"use client";

// MOHD.HMS ENTERPRISE — Petty Cash: shared types + small presentational helpers.
// Every figure renders through money() (integer cents, BND) — never manual math.

import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/hms/shared/ui-bits";
import { money } from "@/lib/hms/format";
import { Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";

export type PCCustodian = { id: string; name: string; email: string } | null;

export type PCStaffOption = { id: string; name: string; email: string; role: string };

export type PCFund = {
  id: string;
  code: string;
  name: string;
  status: string;
  openingBalanceCents: number;
  currentBalanceCents: number;
  custodian: PCCustodian;
  notes: string;
  createdAt: string;
  // Aggregates appended by the API (funds list + summary):
  totalInCents?: number;
  totalOutCents?: number;
  pendingCount?: number;
  transactionCount?: number;
};

export type PCTransaction = {
  id: string;
  code: string;
  fundId: string;
  type: string; // CASH_IN | CASH_OUT | TOP_UP | EXPENSE | REIMBURSEMENT | ADJUSTMENT
  direction: string; // IN | OUT
  amountCents: number;
  category: string;
  description: string;
  txDate: string;
  requesterId: string | null;
  requesterName: string;
  reference: string;
  receiptName: string;
  receiptMimeType: string;
  receiptSizeBytes: number;
  status: string; // PENDING | APPROVED | REJECTED
  reviewNote: string;
  approvedAt: string | null;
  balanceAfterCents: number | null;
  createdById: string | null;
  createdAt: string;
  fund: { id: string; code: string; name: string };
};

export type PCReconciliation = {
  id: string;
  fundId: string;
  expectedCents: number;
  countedCents: number;
  differenceCents: number;
  flagged: boolean;
  note: string;
  createdAt: string;
  fund: { id: string; code: string; name: string };
};

export const TX_TYPES = ["CASH_IN", "CASH_OUT", "TOP_UP", "EXPENSE", "REIMBURSEMENT", "ADJUSTMENT"] as const;

export const TX_TYPE_LABELS: Record<string, string> = {
  CASH_IN: "Cash in",
  CASH_OUT: "Cash out",
  TOP_UP: "Top-up",
  EXPENSE: "Expense",
  REIMBURSEMENT: "Reimbursement",
  ADJUSTMENT: "Adjustment",
};

export function receiptUrl(txId: string): string {
  return `/api/v1/finance/petty-cash/transactions/${txId}/receipt`;
}

/** Signed, colored amount — green for money IN, red for money OUT. */
export function SignedAmount({ direction, cents, className }: { direction: string; cents: number; className?: string }) {
  const isIn = direction === "IN";
  return (
    <span className={cn("tabular-nums font-medium whitespace-nowrap", isIn ? "text-emerald-700" : "text-red-700", className)}>
      {isIn ? "+" : "−"}
      {money(cents)}
    </span>
  );
}

/** Transaction type badge (STATUS_TONE covers every petty cash type). */
export function TxTypeBadge({ type }: { type: string }) {
  return <StatusBadge status={type} />;
}

/** Receipt chip — authorized download link when a receipt exists. */
export function ReceiptChip({ tx }: { tx: Pick<PCTransaction, "id" | "receiptName" | "receiptSizeBytes"> }) {
  if (!tx.receiptName) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <a
      href={receiptUrl(tx.id)}
      className="inline-flex max-w-[140px] items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title={`Download receipt (${tx.receiptName})`}
    >
      <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{tx.receiptName}</span>
    </a>
  );
}

/** Fund chip — code + name for narrow cells. */
export function FundChip({ fund }: { fund: { code: string; name: string } }) {
  return (
    <Badge variant="outline" className="max-w-[150px] gap-1 border-transparent bg-stone-100 font-normal text-stone-700">
      <span className="font-medium">{fund.code}</span>
      <span className="truncate opacity-70">{fund.name}</span>
    </Badge>
  );
}

export function humanErrorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.";
}
