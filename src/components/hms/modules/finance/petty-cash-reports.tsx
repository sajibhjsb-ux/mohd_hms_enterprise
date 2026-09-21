"use client";

// MOHD.HMS ENTERPRISE — Petty Cash ▸ Reports sub-tab (spec §40-§41).
//
// Monthly approved IN vs OUT (last 6 months), top OUT categories, top
// EXPENSE/REIMBURSEMENT requesters and live fund balances. All figures come
// from /api/v1/finance/petty-cash/summary — nothing is computed from stale UI state.

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { StatusBadge, LoadingState, ErrorState, EmptyState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { money } from "@/lib/hms/format";
import { BarChart3, PieChart, Users, Wallet } from "lucide-react";
import { type PCFund } from "./petty-cash-shared";

type Summary = {
  funds: PCFund[];
  monthly: { month: string; inCents: number; outCents: number }[];
  byCategory: { category: string; amountCents: number }[];
  byRequester: { requester: string; amountCents: number }[];
  pendingCount: number;
};

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}

export function PettyCashReportsSubTab() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Summary>("/api/v1/finance/petty-cash/summary");
      setSummary(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Loading petty cash reports…" rows={4} />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!summary) return <EmptyState title="No report data" />;

  const hasFlow = summary.monthly.some((m) => m.inCents !== 0 || m.outCents !== 0);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 min-w-0">
      {/* Monthly summary */}
      <Card className="min-w-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><BarChart3 className="h-4 w-4 text-primary" /> Monthly summary — approved flows, last 6 months</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0">
          {!hasFlow ? (
            <EmptyState title="No approved flows in the window" hint="Monthly totals appear once transactions are approved." />
          ) : (
            <div className="rounded-xl border overflow-x-auto hms-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Cash in</TableHead>
                    <TableHead className="text-right">Cash out</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.monthly.map((m) => {
                    const net = m.inCents - m.outCents;
                    return (
                      <TableRow key={m.month}>
                        <TableCell className="font-medium">{monthLabel(m.month)}</TableCell>
                        <TableCell className="text-right tabular-nums text-emerald-700">{money(m.inCents)}</TableCell>
                        <TableCell className="text-right tabular-nums text-red-700">{money(m.outCents)}</TableCell>
                        <TableCell className={`text-right tabular-nums font-medium ${net >= 0 ? "" : "text-red-700"}`}>{money(net)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fund balances */}
      <Card className="min-w-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Wallet className="h-4 w-4 text-primary" /> Fund balances</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0">
          {summary.funds.length === 0 ? (
            <EmptyState title="No funds yet" hint="Create a petty cash fund to start tracking balances." />
          ) : (
            <div className="rounded-xl border overflow-x-auto hms-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fund</TableHead>
                    <TableHead className="hidden md:table-cell">Custodian</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.funds.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell>
                        <div className="font-medium truncate max-w-[160px]" title={f.name}>{f.name}</div>
                        <div className="text-xs font-mono text-muted-foreground">{f.code}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs">{f.custodian?.name ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs text-emerald-700">{money(f.totalInCents ?? 0)}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs text-red-700">{money(f.totalOutCents ?? 0)}</TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">{money(f.currentBalanceCents)}</TableCell>
                      <TableCell><StatusBadge status={f.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* By category */}
      <Card className="min-w-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><PieChart className="h-4 w-4 text-primary" /> Outflows by category — top 10</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0">
          {summary.byCategory.length === 0 ? (
            <EmptyState title="No approved outflows yet" />
          ) : (
            <div className="rounded-xl border overflow-x-auto hms-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.byCategory.map((c) => (
                    <TableRow key={c.category}>
                      <TableCell className="font-medium">{c.category}</TableCell>
                      <TableCell className="text-right tabular-nums text-red-700">−{money(c.amountCents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* By requester */}
      <Card className="min-w-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4 text-primary" /> By requester — expenses &amp; reimbursements, top 10</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0">
          {summary.byRequester.length === 0 ? (
            <EmptyState title="No attributed expenses yet" hint="Requesters appear once expense or reimbursement transactions are approved." />
          ) : (
            <div className="rounded-xl border overflow-x-auto hms-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Requester</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.byRequester.map((r) => (
                    <TableRow key={r.requester}>
                      <TableCell className="font-medium">{r.requester}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.amountCents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
