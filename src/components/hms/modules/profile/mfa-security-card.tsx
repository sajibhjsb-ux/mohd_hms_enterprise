"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, KeyRound, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { fmtDate } from "@/lib/hms/format";

type Status = {
  enabled: boolean;
  method: string | null;
  enrolledAt: string | null;
  lastVerifiedAt: string | null;
  remainingRecoveryCodes: number;
  policyMode: "MANDATORY" | "OPTIONAL" | "DISABLED";
  canDisable: boolean;
  canReenroll: boolean;
};

type Enrollment = { secret: string; otpauthUri: string; qrDataUrl: string; expiresAt: string };
type Action = "disable" | "regenerate" | "reenroll";

export function MfaSecurityCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await api.get<Status>("/api/v1/auth/mfa/status");
      setStatus(res.data);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function resetForms() {
    setPassword("");
    setCode("");
    setRecoveryCode("");
  }

  function stepUpBody() {
    return {
      ...(password ? { password } : {}),
      ...(code.length === 6 ? { code } : {}),
      ...(recoveryCode ? { recoveryCode } : {}),
    };
  }

  async function enable() {
    if (working) return;
    setWorking(true);
    setCodes(null);
    try {
      const res = await api.post<Enrollment>("/api/v1/auth/mfa/enroll", {});
      setEnrollment(res.data);
      setAction(null);
    } catch (e) {
      toast({ title: "Couldn't start enrolment", description: e instanceof ClientApiError ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setWorking(false);
    }
  }

  async function confirmEnrollment() {
    if (working || !enrollment) return;
    setWorking(true);
    try {
      const res = await api.post<{ recoveryCodes: string[] }>("/api/v1/auth/mfa/confirm-enrollment", { code });
      setCodes(res.data.recoveryCodes);
      setEnrollment(null);
      resetForms();
      await load();
      toast({ title: "Two-factor authentication enabled", description: "Store your recovery codes somewhere safe." });
    } catch (e) {
      toast({ title: "Couldn't verify the code", description: e instanceof ClientApiError ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setWorking(false);
    }
  }

  async function runAction() {
    if (working || !action) return;
    setWorking(true);
    try {
      if (action === "disable") {
        await api.post("/api/v1/auth/mfa/disable", stepUpBody());
        toast({ title: "Two-factor authentication disabled" });
      } else if (action === "regenerate") {
        const res = await api.post<{ recoveryCodes: string[] }>("/api/v1/auth/mfa/regenerate-recovery-codes", stepUpBody());
        setCodes(res.data.recoveryCodes);
        toast({ title: "Recovery codes regenerated", description: "The previous codes no longer work." });
      } else {
        const res = await api.post<Enrollment>("/api/v1/auth/mfa/re-enroll", stepUpBody());
        setEnrollment(res.data);
        toast({ title: "Scan the new QR code", description: "Confirm with a code from the new authenticator." });
      }
      setAction(null);
      resetForms();
      await load();
    } catch (e) {
      toast({ title: "Verification failed", description: e instanceof ClientApiError ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setWorking(false);
    }
  }

  async function copyCodes() {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast({ title: "Recovery codes copied" });
    } catch {
      toast({ title: "Couldn't copy", description: "Select and copy the codes manually.", variant: "destructive" });
    }
  }

  return (
    <Card data-testid="mfa-security-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" aria-hidden /> Two-Factor Authentication
        </CardTitle>
        <CardDescription>Protect your account with an authenticator app.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadFailed ? (
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <ShieldOff className="h-4 w-4" aria-hidden /> Couldn't load MFA status.
            <Button variant="ghost" size="sm" onClick={() => void load()}>Retry</Button>
          </div>
        ) : !status ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={status.enabled ? "default" : "secondary"} data-testid="mfa-status-badge">
                {status.enabled ? "Enabled" : "Not enabled"}
              </Badge>
              <span className="text-muted-foreground">Policy: {status.policyMode.toLowerCase()}</span>
              {status.enabled && <span className="text-muted-foreground">{status.remainingRecoveryCodes} recovery codes left</span>}
            </div>
            {status.enabled && (
              <p className="text-xs text-muted-foreground">
                Enrolled {status.enrolledAt ? fmtDate(status.enrolledAt) : "—"}
                {status.lastVerifiedAt ? ` · Last verified ${fmtDate(status.lastVerifiedAt)}` : ""}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {!status.enabled && (
                <Button size="sm" onClick={() => void enable()} disabled={working} data-testid="mfa-enable-button">
                  {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden /> : null} Enable
                </Button>
              )}
              {status.enabled && status.canDisable && (
                <Button size="sm" variant="outline" onClick={() => setAction("disable")} disabled={working} data-testid="mfa-disable-button">
                  Disable
                </Button>
              )}
              {status.enabled && (
                <>
                  <Button size="sm" variant="outline" onClick={() => setAction("regenerate")} disabled={working}>
                    Regenerate codes
                  </Button>
                  {status.canReenroll && (
                    <Button size="sm" variant="outline" onClick={() => setAction("reenroll")} disabled={working}>
                      Re-enroll
                    </Button>
                  )}
                </>
              )}
            </div>
            {status.enabled && !status.canDisable && (
              <p className="text-xs text-muted-foreground">MFA is required for your role and cannot be disabled.</p>
            )}

            {action && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">Verify it&apos;s you</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="mfa-password">Password</Label>
                    <Input id="mfa-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="mfa-stepup-code">Authenticator code</Label>
                    <Input id="mfa-stepup-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="mfa-recovery">Recovery code</Label>
                    <Input id="mfa-recovery" value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Enter your password and either an authenticator code or a recovery code.</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void runAction()} disabled={working} data-testid="mfa-stepup-submit">
                    {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden /> : <KeyRound className="h-3.5 w-3.5 mr-1.5" aria-hidden />}
                    Confirm
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setAction(null); resetForms(); }} disabled={working}>Cancel</Button>
                </div>
              </div>
            )}

            {enrollment && (
              <div className="space-y-3 rounded-md border p-3" data-testid="mfa-enrollment-panel">
                <p className="text-sm font-medium">Scan this QR code with your authenticator app</p>
                <img src={enrollment.qrDataUrl} alt="MFA enrolment QR code" width={200} height={200} className="rounded-md border" />
                <p className="text-xs text-muted-foreground break-all">Manual key: <span className="font-mono">{enrollment.secret}</span></p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="mfa-code">6-digit code</Label>
                    <Input id="mfa-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} data-testid="mfa-code-input" />
                  </div>
                  <Button size="sm" onClick={() => void confirmEnrollment()} disabled={working || code.length !== 6} data-testid="mfa-confirm-button">
                    {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden /> : null} Confirm
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEnrollment(null)} disabled={working}>Cancel</Button>
                </div>
              </div>
            )}

            {codes && (
              <div className="space-y-2 rounded-md border p-3" data-testid="mfa-recovery-codes">
                <p className="text-sm font-medium">Recovery codes — shown once</p>
                <div className="grid grid-cols-2 gap-1 font-mono text-sm">
                  {codes.map((c) => <span key={c}>{c}</span>)}
                </div>
                <Button size="sm" variant="outline" onClick={() => void copyCodes()}>
                  <Copy className="h-3.5 w-3.5 mr-1.5" aria-hidden /> Copy codes
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCodes(null)}>Done</Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
