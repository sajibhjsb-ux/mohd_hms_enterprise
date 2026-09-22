"use client";

// MOHD.HMS ENTERPRISE — Petty Cash ▸ Reconciliation sub-tab (spec §39).
//
// Physical cash count vs the fund's book balance. The math is shown
// transparently (Opening + In − Out = Expected), differences are FLAGGED for
// review — reconciliation NEVER silently adjusts a balance.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { fmtDateTime, money } from "@/lib/hms/format";
import { Scale, TriangleAlert, CheckCircle2 } from "lucide-react";
import { humanErrorMessage, type PCFund, type PCReconciliation } from "./petty-cash-shared";

export function PettyCashReconciliationSubTab({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const [funds, setFunds] = useState<PCFund[]>([]);
  const [fundId, setFundId] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ flagged: boolean; differenceCents: number } | null>(null);

  const [history, setHistory] = useState<PCReconciliation[]>([]);
  const [histLoading, setHistLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFunds = useCallback(async () => {
    try {
      const res = await api.get<PCFund[]>("/api/v1/finance/petty-cash/funds?pageSize=200");
      setFunds(res.data);
      setFundId((prev) => (res.data.some((f) => f.id === prev) ? prev : res.data[0]?.id ?? ""));
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    }
  }, []);

  const loadHistory = useCallback(async (f: string) => {
    setHistLoading(true);
    setError(null);
    try {
      const res = await api.get<PCReconciliation[]>(`/api/v1/finance/petty-cash/reconcile${qs({ pageSize: 100, fundId: f || undefined })}`);
      setHistory(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setHistLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFunds();
  }, [loadFunds]);

  useEffect(() => {
    void loadHistory(fundId);
  }, [fundId, loadHistory]);

  const fund = funds.find((f) => f.id === fundId) ?? null;
  const expectedCents = fund?.currentBalanceCents ?? 0;
  const countedCents = counted === "" ? null : Math.round((Number(counted) || 0) * 100);
  const liveDifference = countedCents === null ? null : countedCents - expectedCents;

  async function submit() {
    if (!fund) {
      toast({ title: "Select a fund first", variant: "destructive" });
      return;
    }
    if (counted === "" || Number.isNaN(Number(counted)) || Number(counted) < 0) {
      toast({ title: "Counted cash required", description: "Enter the physical cash counted in the drawer.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<PCReconciliation>("/api/v1/finance/petty-cash/reconcile", {
        fundId: fund.id,
        countedAmount: Number(counted),
        note: note.trim() || undefined,
      });
      setBanner({ flagged: res.data.flagged, differenceCents: res.data.differenceCents });
      if (res.data.flagged) {
        toast({
          title: `Difference of ${money(Math.abs(res.data.differenceCents))} flagged for review`,
          description: "The book balance was NOT changed — investigate the difference.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Reconciled — balanced", description: `${fund.code} matches its book balance.` });
      }
      setCounted("");
      setNote("");
      await loadHistory(fund.id);
    } catch (e) {
      toast({ title: "Reconciliation failed", description: humanErrorMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 min-w-0">
      {banner ? (
        banner.flagged ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <div>
              <span className="font-medium">Difference of {money(Math.abs(banner.differenceCents))} flagged for review.</span>{" "}
              The book balance was not changed — investigate before the next count.
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <span><span className="font-medium">Reconciled — balanced.</span> The counted cash matches the book balance.</span>
          </div>
        )
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-w-0">
        <Card className="min-w-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><Scale className="h-4 w-4 text-primary" /> Count physical cash</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pcrec-fund">Fund</Label>
              <Select value={fundId} onValueChange={setFundId}>
                <SelectTrigger id="pcrec-fund"><SelectValue placeholder="Select fund" /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {funds.map((f) => <SelectItem key={f.id} value={f.id}>{f.code} · {f.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {fund ? (
              <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1" aria-live="polite">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Book balance calculation</div>
                <div className="tabular-nums leading-relaxed">
                  Opening {money(fund.openingBalanceCents)} + In {money(fund.totalInCents ?? 0)} − Out {money(fund.totalOutCents ?? 0)} ={" "}
                  <span className="font-semibold">Expected {money(expectedCents)}</span>
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="pcrec-counted">Counted cash (BND)</Label>
              <Input
                id="pcrec-counted"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
                placeholder="0.00"
                disabled={!fund}
              />
            </div>

            {liveDifference !== null ? (
              <div className={`rounded-lg p-3 text-sm font-medium ${liveDifference === 0 ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
                {liveDifference === 0
                  ? "Balanced — counted cash matches the book balance."
                  : `Difference: ${liveDifference > 0 ? "+" : "−"}${money(Math.abs(liveDifference))} ${liveDifference > 0 ? "(surplus)" : "(shortage)"} — will be flagged for review.`}
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="pcrec-note">Note</Label>
              <Textarea id="pcrec-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Optional — context for the count (e.g. voucher pending)" disabled={!fund} />
            </div>

            {canManage ? (
              <Button onClick={() => void submit()} disabled={busy || !fund || counted === ""}>
                <Scale className="h-4 w-4 mr-1.5" /> Submit reconciliation
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Only Finance managers can submit reconciliations.</p>
            )}
            <p className="text-xs text-muted-foreground">
              Reconciliations never adjust the balance — a difference is flagged for a human to resolve.
            </p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Reconciliation history</CardTitle>
          </CardHeader>
          <CardContent className="min-w-0">
            {error ? (
              <ErrorState message={error} onRetry={() => { void loadFunds(); void loadHistory(fundId); }} />
            ) : histLoading ? (
              <LoadingState rows={3} label="Loading history…" />
            ) : history.length === 0 ? (
              <EmptyState title="No reconciliations yet" hint="Counts will appear here after the first submission." />
            ) : (
              <div className="rounded-xl border overflow-y-auto max-h-96 hms-scroll">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead className="hidden md:table-cell">Fund</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="text-right">Counted</TableHead>
                      <TableHead className="text-right">Difference</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden md:table-cell">Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(h.createdAt)}</TableCell>
                        <TableCell className="hidden md:table-cell text-xs font-mono">{h.fund.code}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{money(h.expectedCents)}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{money(h.countedCents)}</TableCell>
                        <TableCell className={`text-right tabular-nums text-xs font-medium ${h.differenceCents === 0 ? "text-emerald-700" : "text-red-700"}`}>
                          {h.differenceCents > 0 ? "+" : h.differenceCents < 0 ? "−" : ""}{money(Math.abs(h.differenceCents))}
                        </TableCell>
                        <TableCell><StatusBadge status={h.flagged ? "FLAGGED" : "RECONCILED"} /></TableCell>
                        <TableCell className="hidden md:table-cell max-w-[160px] truncate text-xs text-muted-foreground" title={h.note}>{h.note || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
