"use client";

// MOHD.HMS ENTERPRISE — Finance ▸ Petty Cash tab (spec §31-§41).
//
// Self-fetching tab (no props) with four sub-tabs:
//   Funds           — fund cards, create / edit / activate / deactivate
//   Transactions    — server-filtered list, submit for approval, approve / reject
//   Reconciliation  — physical count vs book balance, differences FLAGGED (never auto-adjusted)
//   Reports         — monthly summary, by category, by requester, fund balances
//
// Every amount renders through money() (integer cents). Balances move ONLY on
// approval — the UI never pretends otherwise.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageHeader, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useSession, hasPerm } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { money } from "@/lib/hms/format";
import { PERMISSIONS } from "@/lib/hms/constants";
import { Wallet, Plus, Pencil, PowerOff, Power, RefreshCcw, UserRound } from "lucide-react";
import { PettyCashTransactionsSubTab } from "./petty-cash-transactions";
import { PettyCashReconciliationSubTab } from "./petty-cash-reconciliation";
import { PettyCashReportsSubTab } from "./petty-cash-reports";
import { humanErrorMessage, type PCFund, type PCStaffOption } from "./petty-cash-shared";

export function PettyCashTab() {
  const { user } = useSession();
  const canRead = hasPerm(user, PERMISSIONS.finance_read);
  const canManage = hasPerm(user, PERMISSIONS.finance_manage);

  const [tab, setTab] = useState("funds");
  const [summary, setSummary] = useState<{ pendingCount: number } | null>(null);

  const loadPendingCount = useCallback(() => {
    if (!canRead) return;
    // .then-style keeps setState out of the synchronous effect path — the
    // badge is cosmetic and must never block the tab.
    api.get<{ pendingCount: number }>("/api/v1/finance/petty-cash/summary")
      .then((res) => setSummary({ pendingCount: res.data.pendingCount }))
      .catch(() => { /* badge stays stale; nothing breaks */ });
  }, [canRead]);

  useEffect(() => {
    void loadPendingCount();
  }, [loadPendingCount]);

  if (!canRead) {
    return (
      <EmptyState
        title="Finance access required"
        hint="Your role does not include finance visibility, so petty cash is not available."
      />
    );
  }

  return (
    <div className="space-y-5 min-w-0">
      <PageHeader
        title="Petty Cash"
        subtitle="Imprest funds, cash movements and physical reconciliations — balances move only on approval"
        actions={
          <Button variant="outline" size="sm" onClick={() => void loadPendingCount()}>
            <RefreshCcw className="h-4 w-4 mr-1.5" /> Refresh
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 flex-wrap h-auto">
          <TabsTrigger value="funds">Funds</TabsTrigger>
          <TabsTrigger value="transactions">
            Transactions{summary && summary.pendingCount > 0 ? ` (${summary.pendingCount})` : ""}
          </TabsTrigger>
          <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        <TabsContent value="funds" className="min-w-0">
          <FundsSubTab canManage={canManage} onChanged={() => void loadPendingCount()} />
        </TabsContent>
        <TabsContent value="transactions" className="min-w-0">
          <PettyCashTransactionsSubTab canManage={canManage} currentUserId={user?.id ?? ""} isAdmin={user?.role === "ADMIN" || user?.role === "SUPER_ADMIN"} onChanged={() => void loadPendingCount()} />
        </TabsContent>
        <TabsContent value="reconciliation" className="min-w-0">
          <PettyCashReconciliationSubTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="reports" className="min-w-0">
          <PettyCashReportsSubTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Funds sub-tab ──

function FundsSubTab({ canManage, onChanged }: { canManage: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [funds, setFunds] = useState<PCFund[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editFund, setEditFund] = useState<PCFund | null>(null);
  const [deactivateFund, setDeactivateFund] = useState<PCFund | null>(null);
  const [busy, setBusy] = useState(false);

  const loadFunds = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<PCFund[]>("/api/v1/finance/petty-cash/funds?pageSize=200");
      setFunds(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFunds();
  }, [loadFunds]);

  async function toggleStatus(fund: PCFund, next: "ACTIVE" | "INACTIVE") {
    setBusy(true);
    try {
      await api.patch<PCFund>(`/api/v1/finance/petty-cash/funds/${fund.id}`, { status: next });
      toast({
        title: next === "ACTIVE" ? `Fund ${fund.code} activated` : `Fund ${fund.code} deactivated`,
        description: next === "INACTIVE" ? "No new transactions can be recorded against this fund." : undefined,
      });
      setDeactivateFund(null);
      await loadFunds();
      onChanged();
    } catch (e) {
      toast({ title: "Action failed", description: humanErrorMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex justify-end">
        {canManage ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> New fund
          </Button>
        ) : null}
      </div>

      {error ? <ErrorState message={error} onRetry={loadFunds} /> : null}

      {loading ? (
        <LoadingState label="Loading petty cash funds…" />
      ) : funds.length === 0 ? (
        <EmptyState
          title="No petty cash funds yet"
          hint={canManage ? "Create the first imprest fund and assign a custodian." : "Funds will appear here once Finance creates them."}
          action={canManage ? <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> New fund</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {funds.map((fund) => (
            <Card key={fund.id} className="min-w-0">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate" title={fund.name}>{fund.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{fund.code}</div>
                  </div>
                  <StatusBadge status={fund.status} />
                </div>

                <div>
                  <div className="text-2xl font-semibold tabular-nums tracking-tight">{money(fund.currentBalanceCents)}</div>
                  <div className="text-xs text-muted-foreground">Current balance · opened at {money(fund.openingBalanceCents)}</div>
                </div>

                <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                  <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{fund.custodian ? `${fund.custodian.name} · custodian` : "No custodian assigned"}</span>
                </div>

                <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-2 text-center">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">In</div>
                    <div className="text-sm font-medium tabular-nums text-emerald-700 truncate">{money(fund.totalInCents ?? 0)}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Out</div>
                    <div className="text-sm font-medium tabular-nums text-red-700 truncate">{money(fund.totalOutCents ?? 0)}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Pending</div>
                    <div className="text-sm font-medium tabular-nums">{fund.pendingCount ?? 0}</div>
                  </div>
                </div>

                {canManage ? (
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => setEditFund(fund)}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                    </Button>
                    {fund.status === "ACTIVE" ? (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDeactivateFund(fund)}>
                        <PowerOff className="h-3.5 w-3.5 mr-1" /> Deactivate
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void toggleStatus(fund, "ACTIVE")}>
                        <Power className="h-3.5 w-3.5 mr-1" /> Activate
                      </Button>
                    )}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <FundFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        fund={null}
        onSaved={async () => { setCreateOpen(false); await loadFunds(); onChanged(); }}
      />
      <FundFormDialog
        open={editFund !== null}
        onOpenChange={(o) => { if (!o) setEditFund(null); }}
        fund={editFund}
        onSaved={async () => { setEditFund(null); await loadFunds(); onChanged(); }}
      />

      <AlertDialog open={deactivateFund !== null} onOpenChange={(o) => { if (!o) setDeactivateFund(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate fund {deactivateFund?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              The balance is preserved but no new transactions can be recorded against an inactive fund.
              Funds with pending transactions cannot be deactivated — settle those first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={(e) => { e.preventDefault(); if (deactivateFund) void toggleStatus(deactivateFund, "INACTIVE"); }}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Fund create / edit dialog ──

function FundFormDialog({
  open, onOpenChange, fund, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  fund: PCFund | null;
  onSaved: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const isEdit = fund !== null;
  const [staff, setStaff] = useState<PCStaffOption[]>([]);
  const [name, setName] = useState("");
  const [opening, setOpening] = useState("0.00");
  const [custodianId, setCustodianId] = useState("none");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.get<PCStaffOption[]>("/api/v1/finance/petty-cash/custodians")
      .then((res) => { if (alive) setStaff(res.data); })
      .catch(() => { /* picker degrades to empty — server still validates */ });
    setName(fund?.name ?? "");
    setOpening(fund ? (fund.openingBalanceCents / 100).toFixed(2) : "0.00");
    setCustodianId(fund?.custodian?.id ?? "none");
    setNotes(fund?.notes ?? "");
    return () => { alive = false; };
  }, [open, fund]);

  async function submit() {
    if (!name.trim()) {
      toast({ title: "Fund name required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      if (isEdit && fund) {
        await api.patch<PCFund>(`/api/v1/finance/petty-cash/funds/${fund.id}`, {
          name: name.trim(),
          custodianId: custodianId === "none" ? null : custodianId,
          notes: notes.trim(),
        });
        toast({ title: `Fund ${fund.code} updated` });
      } else {
        const res = await api.post<PCFund>("/api/v1/finance/petty-cash/funds", {
          name: name.trim(),
          openingBalance: Number(opening) || 0,
          custodianId: custodianId === "none" ? null : custodianId,
          notes: notes.trim(),
        });
        toast({
          title: `Fund ${res.data.code} created`,
          description: `Opened with ${money(res.data.currentBalanceCents)}.`,
        });
      }
      await onSaved();
    } catch (e) {
      toast({ title: isEdit ? "Update failed" : "Could not create fund", description: humanErrorMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit fund ${fund?.code}` : "New petty cash fund"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "The opening and current balances never change from this dialog — they move only through approved transactions."
              : "The fund opens with the given balance; every movement afterwards requires Finance approval."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pcf-name">Fund name</Label>
            <Input id="pcf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Office imprest — Jalan besar" maxLength={120} />
          </div>

          {!isEdit ? (
            <div className="space-y-1.5">
              <Label htmlFor="pcf-opening">Opening balance (BND)</Label>
              <Input id="pcf-opening" type="number" min="0" step="0.01" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
              <p className="text-xs text-muted-foreground">Count the physical cash before opening — this becomes the book balance.</p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="pcf-custodian">Custodian</Label>
            <Select value={custodianId} onValueChange={setCustodianId}>
              <SelectTrigger id="pcf-custodian"><SelectValue placeholder="Select custodian" /></SelectTrigger>
              <SelectContent className="max-h-60">
                <SelectItem value="none">No custodian</SelectItem>
                {staff.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name} · {s.role}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">The person accountable for the physical cash.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pcf-notes">Notes</Label>
            <Textarea id="pcf-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} placeholder="Optional — purpose, location, top-up cadence…" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>
            <Wallet className="h-4 w-4 mr-1.5" /> {isEdit ? "Save changes" : "Create fund"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
