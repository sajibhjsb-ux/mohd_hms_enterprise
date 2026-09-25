"use client";

// MOHD.HMS ENTERPRISE — Profile → Security → Login & Session Security.
// USER-CONTROLLED AUTO LOGIN (spec §1/§3/§8/§10): per-device persistent-login
// management inside the EXISTING profile architecture — no second session
// system. The backend is authoritative (the toggle only talks to
// /api/v1/auth/auto-login/{enable,disable}); this card displays real state:
//   • AUTO LOGIN switch for THIS device (default OFF, server-held).
//   • Active Sessions list: device, Auto Login ON/OFF, last activity, IP,
//     status — with per-session [Sign Out] and [Sign Out All Other Sessions].
// Honest states only: SAVING disables the control, SAVED/ERROR are toasts
// backed by the actual server response, and the list is re-fetched after
// every mutation (no optimistic lies).

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, LogOut, Monitor, ShieldCheck, ShieldX, Smartphone } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { fmtDate } from "@/lib/hms/format";

type SessionRow = {
  id: string;
  current: boolean;
  device: string;
  autoLogin: boolean;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function DeviceIcon({ device }: { device: string }) {
  const mobile = /Android|iOS/.test(device);
  const Icon = mobile ? Smartphone : Monitor;
  return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />;
}

export function SecuritySessionsCard() {
  const { toast } = useToast();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await api.get<{ sessions: SessionRow[] }>("/api/v1/auth/sessions");
      setRows(res.data.sessions);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const current = rows?.find((r) => r.current) ?? null;
  const others = rows?.filter((r) => !r.current && r.status !== "EXPIRED") ?? [];

  async function toggleAutoLogin(next: boolean) {
    if (savingAuto) return;
    setSavingAuto(true);
    try {
      await api.post(`/api/v1/auth/auto-login/${next ? "enable" : "disable"}`, {});
      toast({
        title: next ? "Auto login enabled" : "Auto login disabled",
        description: next
          ? "This device stays signed in until its session expires, you sign out, or another device signs in."
          : "Auto login disabled for this device.",
      });
      await load();
    } catch (e) {
      toast({
        title: "Couldn't update auto login",
        description: e instanceof ClientApiError ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingAuto(false);
    }
  }

  async function revoke(id: string, isCurrent: boolean) {
    if (workingId) return;
    setWorkingId(id);
    try {
      await api.del(`/api/v1/auth/sessions/${id}`);
      if (isCurrent) {
        // Revoking THIS device's session = a real logout — full teardown so
        // sockets/polls/caches die with it (mirrors the existing signOut).
        window.location.assign("/");
        return;
      }
      toast({ title: "Session signed out" });
      await load();
    } catch (e) {
      toast({
        title: "Couldn't sign out the session",
        description: e instanceof ClientApiError ? e.message : "Please try again.",
        variant: "destructive",
      });
      await load();
    } finally {
      setWorkingId(null);
    }
  }

  async function revokeOthers() {
    if (revokingOthers) return;
    setRevokingOthers(true);
    try {
      const res = await api.post<{ revoked: number }>("/api/v1/auth/sessions/revoke-others", {});
      toast({
        title: "Other sessions signed out",
        description: `${res.data?.revoked ?? 0} session(s) on other devices can no longer auto-login.`,
      });
      await load();
    } catch (e) {
      toast({
        title: "Couldn't sign out other sessions",
        description: e instanceof ClientApiError ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setRevokingOthers(false);
    }
  }

  return (
    <Card data-testid="security-sessions-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" aria-hidden /> Login &amp; Session Security
        </CardTitle>
        <CardDescription>Auto login and active sessions for your account.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* AUTO LOGIN (per device) */}
        <div className="flex items-start justify-between gap-4" data-testid="auto-login-control">
          <div className="space-y-1">
            <p className="text-sm font-medium">Auto login</p>
            <p className="text-sm text-muted-foreground">
              Keep me signed in on this device — your secure session persists on this device until
              it expires. Your password is never stored.
            </p>
            <p className="text-sm text-muted-foreground">
              Only one device can be actively signed in to this account at a time. Signing in on
              another device automatically ends the previous active session.
            </p>
            <p className="text-xs text-muted-foreground pt-1" data-testid="auto-login-state">
              {savingAuto
                ? "Saving…"
                : current?.autoLogin
                  ? `Auto login is ON for this device — session expires ${fmtDate(current.expiresAt)}.`
                  : "Auto login disabled for this device."}
            </p>
          </div>
          <Switch
            aria-label="Auto login on this device"
            data-testid="auto-login-switch"
            checked={!!current?.autoLogin}
            onCheckedChange={(v) => void toggleAutoLogin(v === true)}
            disabled={savingAuto || !current}
          />
        </div>

        {/* ACTIVE SESSIONS (per device) */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Active sessions</p>
            <Button
              variant="outline"
              size="sm"
              data-testid="revoke-others"
              onClick={() => void revokeOthers()}
              disabled={revokingOthers || others.length === 0}
            >
              {revokingOthers ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden /> : <LogOut className="h-3.5 w-3.5 mr-1.5" aria-hidden />}
              Sign Out All Other Sessions{others.length ? ` (${others.length})` : ""}
            </Button>
          </div>

          {loadFailed ? (
            <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
              <ShieldX className="h-4 w-4" aria-hidden /> Couldn't load sessions.{" "}
              <Button variant="ghost" size="sm" onClick={() => void load()}>Retry</Button>
            </div>
          ) : !rows ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-5/6" />
            </div>
          ) : (
            <ul className="rounded-md border divide-y" data-testid="session-list">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 py-2.5">
                  <DeviceIcon device={r.device} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {r.device}
                      {r.current ? (
                        <Badge variant="secondary" className="ml-2">This device</Badge>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      Auto login: {r.autoLogin ? "ON" : "OFF"} · Last active {timeAgo(r.lastSeenAt)}
                      {r.ip ? ` · ${r.ip}` : ""}
                      {r.status === "REVOKED" ? " · Signed out (another device)" : ""}
                      {r.status === "EXPIRED" ? " · Expired" : ""}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`sign-out-session-${r.id}`}
                    onClick={() => void revoke(r.id, r.current)}
                    disabled={workingId === r.id}
                  >
                    {workingId === r.id
                      ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden />
                      : <LogOut className="h-3.5 w-3.5 mr-1.5" aria-hidden />}
                    Sign Out
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
