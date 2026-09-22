"use client";

// MOHD.HMS ENTERPRISE — User Edit page "Corporate email" card (email
// provisioning spec §8/§29). Shows the REAL backend provisioning state:
// corporate address, lifecycle status (PENDING/PROVISIONING/ACTIVE/FAILED/
// DISABLED), mailbox availability and role-based shared access — plus the
// authorized administrator actions ([Provision]/[Retry Provisioning]/
// [Disable Mailbox]/[Re-enable Mailbox], §29) gated by the email.config
// permission on BOTH sides (UI + API). The status auto-polls while a
// provisioning run is in flight (the outbox worker processes it asynchronously).

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Mail, MailX, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type ProvisioningStatus = {
  userId: string;
  userRole: string;
  corporateEmail: string;
  mailboxId: string | null;
  mailboxActive: boolean;
  status: string; // NOT_REQUIRED | PENDING | PROVISIONING | ACTIVE | FAILED | DISABLED
  attempts: number;
  lastError: string;
  provisionedAt: string | null;
  disabledAt: string | null;
  sharedAccess: { mailboxId: string; email: string; displayName: string; canSend: boolean; managedByRole: boolean }[];
};

type ProvisioningAction = "provision" | "retry" | "disable" | "enable";

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800 border-emerald-200",
  PROVISIONING: "bg-sky-100 text-sky-800 border-sky-200",
  PENDING: "bg-amber-100 text-amber-800 border-amber-200",
  FAILED: "bg-red-100 text-red-800 border-red-200",
  DISABLED: "bg-stone-100 text-stone-700 border-stone-200",
  NOT_REQUIRED: "bg-stone-100 text-stone-700 border-stone-200",
};

function StatusIcon({ status }: { status: string }) {
  if (status === "ACTIVE") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />;
  if (status === "FAILED") return <AlertTriangle className="h-3.5 w-3.5 text-red-600" aria-hidden />;
  if (status === "PROVISIONING" || status === "PENDING") return <Clock className="h-3.5 w-3.5 animate-pulse text-sky-600" aria-hidden />;
  if (status === "DISABLED") return <MailX className="h-3.5 w-3.5 text-stone-500" aria-hidden />;
  return <Mail className="h-3.5 w-3.5 text-stone-400" aria-hidden />;
}

const isStaffRole = (role: string) => role !== "CUSTOMER";

export function CorporateEmailCard({ userId, role, onChanged }: { userId: string; role: string; onChanged?: () => void }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canConfig = hasPerm(user, "email.config");
  const [status, setStatus] = useState<ProvisioningStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ProvisioningStatus>(`/api/v1/email/provisioning?userId=${encodeURIComponent(userId)}`);
      setStatus(res.data);
      setLoadFailed(false);
    } catch {
      // users_read holders without email-config can still read the single-user
      // status; a failure here is a network/permission edge — render the
      // "unavailable" hint rather than fake state.
      setLoadFailed(true);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-fetch when the role changes (this page's own role change): provisioning
  // runs ASYNC on the outbox worker, so the status transitions
  // DISABLED/NOT_REQUIRED → PROVISIONING → ACTIVE a few seconds later.
  const [pendingRechecks, setPendingRechecks] = useState(0);
  const roleRef = useRef(role);
  useEffect(() => {
    if (roleRef.current === role) return;
    roleRef.current = role;
    void load();
    // A staff role expects an ACTIVE mailbox within seconds — schedule a
    // bounded re-check window; a CUSTOMER role settles immediately.
    setPendingRechecks(isStaffRole(role) ? 6 : 0);
  }, [role, load]);

  // Auto-poll while a provisioning run is in flight OR during the bounded
  // post-role-change re-check window (async outbox worker, §26).
  useEffect(() => {
    const inFlight = status?.status === "PENDING" || status?.status === "PROVISIONING";
    const awaitingRestore = pendingRechecks > 0 && (status?.status === "NOT_REQUIRED" || status?.status === "DISABLED" || status?.status === "PENDING" || status?.status === "PROVISIONING");
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (inFlight || awaitingRestore) {
      pollRef.current = setInterval(() => {
        if (awaitingRestore) setPendingRechecks((n) => n - 1);
        void load();
      }, 3000);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [status?.status, pendingRechecks, load]);

  const act = async (action: ProvisioningAction) => {
    setBusy(true);
    try {
      const res = await api.post<ProvisioningStatus>("/api/v1/email/provisioning", { userId, action });
      setStatus(res.data);
      const label = action === "provision" ? "Provisioning started" : action === "retry" ? "Retry finished" : action === "disable" ? "Mailbox disabled" : "Mailbox re-enabled";
      toast({ title: label, description: res.data.corporateEmail || undefined });
      onChanged?.();
    } catch (e) {
      toast({ title: `Could not ${action} mailbox`, description: e instanceof Error ? e.message : "", variant: "destructive" });
      void load(); // re-sync honest state after a failed action
    } finally {
      setBusy(false);
    }
  };

  if (loadFailed) {
    return (
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Mail className="h-4 w-4 text-primary" aria-hidden /> Corporate email</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Provisioning status is unavailable for your permissions.</p>
        </CardContent>
      </Card>
    );
  }

  const s = status;
  const inFlight = s?.status === "PENDING" || s?.status === "PROVISIONING";
  const showProvision = canConfig && isStaffRole(role) && (!s || s.status === "NOT_REQUIRED");
  const showRetry = canConfig && (s?.status === "FAILED" || (inFlight && s && s.attempts > 0) || (isStaffRole(role) && s?.status === "DISABLED"));
  const showEnable = canConfig && s?.status === "DISABLED" && isStaffRole(role);
  const showDisable = canConfig && s?.status === "ACTIVE" && !isStaffRole(role);
  const showAnyAction = showProvision || showRetry || showEnable || showDisable;

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4 text-primary" aria-hidden /> Corporate email
        </CardTitle>
        <CardDescription>
          Provisioned automatically when the account becomes a staff role — personal sign-in email stays unchanged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!s || s.status === "NOT_REQUIRED" ? (
          <p className="text-sm text-muted-foreground">
            {isStaffRole(role)
              ? "No corporate mailbox yet. Staff roles receive one automatically on promotion — or provision it now."
              : "Customer accounts do not receive a corporate mailbox."}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={`font-medium border ${STATUS_TONE[s.status] ?? ""}`}>
                <StatusIcon status={s.status} />
                <span className="ml-1">{s.status === "ACTIVE" ? "ACTIVE" : s.status === "FAILED" ? "FAILED" : s.status === "DISABLED" ? "DISABLED" : "PROVISIONING"}</span>
              </Badge>
              {s.mailboxId ? (
                <Badge variant="outline" className="font-normal">
                  {s.mailboxActive ? "Mailbox available" : "Mailbox suspended"}
                </Badge>
              ) : null}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Corporate address</p>
              <p className="text-sm font-medium break-all">{s.corporateEmail || "—"}</p>
            </div>
            {s.status === "FAILED" && s.lastError ? (
              <p className="text-xs rounded-md bg-red-50 border border-red-200 px-3 py-2 text-red-800 flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
                {s.lastError}
              </p>
            ) : null}
            {inFlight ? (
              <p className="text-xs rounded-md bg-sky-50 border border-sky-200 px-3 py-2 text-sky-800 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 animate-pulse" aria-hidden /> Provisioning is running — this card refreshes automatically.
              </p>
            ) : null}
            <div>
              <p className="text-xs text-muted-foreground">Shared mailbox access ({s.sharedAccess.length})</p>
              {s.sharedAccess.length === 0 ? (
                <p className="text-sm text-muted-foreground">No shared mailboxes assigned.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {s.sharedAccess.map((m) => (
                    <li key={m.mailboxId} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium break-all">{m.email}</span>
                      {m.canSend ? <Badge variant="outline" className="text-[10px] font-normal">send</Badge> : null}
                      {m.managedByRole ? (
                        <Badge variant="outline" className="text-[10px] font-normal">role mapping</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] font-normal">assigned by admin</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {canConfig && showAnyAction ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {showProvision ? (
              <Button size="sm" disabled={busy} onClick={() => void act("provision")}>
                {busy ? <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" /> : <Mail className="h-4 w-4 mr-1.5" />}
                Provision mailbox
              </Button>
            ) : null}
            {showRetry ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("retry")}>
                {busy ? <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1.5" />}
                Retry provisioning
              </Button>
            ) : null}
            {showEnable ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("enable")}>
                {busy ? <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
                Re-enable mailbox
              </Button>
            ) : null}
            {showDisable ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("disable")}>
                {busy ? <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" /> : <MailX className="h-4 w-4 mr-1.5" />}
                Disable mailbox
              </Button>
            ) : null}
          </div>
        ) : null}

        {canConfig ? (
          <p className="text-[11px] text-muted-foreground flex items-start gap-1">
            <ShieldCheck className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
            Mailbox data is never deleted by role changes — staff downgrades suspend the mailbox and revoke staff shared access only.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
