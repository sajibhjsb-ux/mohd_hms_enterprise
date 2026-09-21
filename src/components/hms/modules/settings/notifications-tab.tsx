"use client";

// MOHD.HMS ENTERPRISE — Settings → Notifications (admin Push notification
// center, spec §30) + real test-notification sender (spec §31).
//
// Everything shown comes from the backend's authoritative records (PushLog /
// PushDevice / channel config). The test sender reports the ACTUAL FCM/VAPID
// result — "Success" is only shown when the transport accepted the message.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  BellRing, CheckCircle2, RefreshCw, Send, ShieldAlert, Smartphone, XCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/hms/api-client";

type Overview = {
  channels: {
    fcm: { configured: boolean; projectId: string | null; clientReady: boolean; toggleOn: boolean };
    vapid: { configured: boolean };
  };
  devices: { fcmTotal: number; fcmActive: number; vapidActive: number };
  deliveries7d: { queued: number; sending: number; sent: number; failed: number; deadLettered: number; skipped: number };
  recent: Array<{
    id: string; status: string; channel: string; priority: string; title: string; body: string;
    userName: string; deviceCount: number; sentCount: number; failedCount: number; skippedCount: number;
    attemptCount: number; errorCode: string; lastError: string; isTest: boolean; createdAt: string;
  }>;
  recentErrors: Array<{ id: string; status: string; channel: string; errorCode: string; lastError: string; title: string; userName: string; updatedAt: string }>;
};

type UserOption = { id: string; name: string; email: string };
type DeviceOption = { id: string; kind: string; label: string; active: boolean };
type TestResult = {
  status: string; channel: string; deviceCount: number; sentCount: number; failedCount: number;
  skippedCount: number; fcmMessageId?: string; errorCode?: string; error?: string;
};

function statusBadge(status: string) {
  const map: Record<string, string> = {
    SENT: "border-emerald-300 text-emerald-700 bg-emerald-50",
    QUEUED: "border-sky-300 text-sky-700 bg-sky-50",
    SENDING: "border-sky-300 text-sky-700 bg-sky-50",
    FAILED: "border-red-300 text-red-700 bg-red-50",
    DEAD_LETTER: "border-red-300 text-red-700 bg-red-50",
    SKIPPED: "border-amber-300 text-amber-700 bg-amber-50",
  };
  return <Badge variant="outline" className={`text-[10px] ${map[status] ?? ""}`}>{status}</Badge>;
}

export function NotificationsTab() {
  const { toast } = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  // Test sender state (device uses a sentinel — Radix Select forbids "" values)
  const DEVICE_ALL = "__all__";
  const [users, setUsers] = useState<UserOption[]>([]);
  const [userId, setUserId] = useState("");
  const [devices, setDevices] = useState<DeviceOption[] | null>(null);
  const [deviceId, setDeviceId] = useState(DEVICE_ALL);
  const [title, setTitle] = useState("Firebase test notification");
  const [body, setBody] = useState("This is a test push from MOHD.HMS ENTERPRISE.");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<Overview>("/api/v1/push/admin/overview");
      setOverview(res.data);
    } catch (e) {
      toast({ title: "Failed to load push overview", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    // Recipient picker — reuse the existing users API (admin already holds users.read).
    void api.get<{ data?: UserOption[] } | { data: UserOption[] }>("/api/v1/users?pageSize=200&sort=name")
      .then((res) => {
        const rows = (res.data as unknown as { data?: UserOption[] })?.data ?? (res.data as unknown as UserOption[]) ?? [];
        setUsers(Array.isArray(rows) ? rows : []);
      })
      .catch(() => setUsers([]));
  }, [load]);

  async function onUserSelected(value: string) {
    setUserId(value);
    setDevices(null);
    setDeviceId(DEVICE_ALL);
    setResult(null);
    try {
      const res = await api.get<{ devices: DeviceOption[] }>(`/api/v1/push/admin/devices?userId=${encodeURIComponent(value)}`);
      setDevices(res.data.devices);
    } catch {
      setDevices([]);
    }
  }

  async function onSendTest() {
    if (!userId) return;
    setSending(true);
    setResult(null);
    try {
      const res = await api.post<TestResult>("/api/v1/push/admin/test", {
        userId,
        deviceId: deviceId && deviceId !== DEVICE_ALL ? deviceId : undefined,
        title,
        body,
      });
      setResult(res.data);
      if (res.data.status === "SENT") {
        toast({ title: "Test notification delivered", description: `${res.data.sentCount}/${res.data.deviceCount} device(s) accepted.` });
      } else {
        toast({ title: `Test push ${res.data.status.toLowerCase()}`, description: res.data.error ?? res.data.errorCode ?? "See the result details.", variant: "destructive" });
      }
      void load();
    } catch (e) {
      toast({ title: "Test send failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  const fcm = overview?.channels.fcm;
  const fcmReady = !!fcm?.configured && !!fcm?.clientReady;
  const resultSummary = useMemo(() => {
    if (!result) return null;
    if (result.status === "SENT") return `${result.sentCount}/${result.deviceCount} device(s) accepted by ${result.channel}.`;
    if (result.status === "SKIPPED") return `Skipped — ${result.error ?? result.errorCode ?? "channel not available"}.`;
    return `Failed — ${result.error ?? result.errorCode ?? "unknown error"}.`;
  }, [result]);

  return (
    <div className="space-y-4">
      {/* Channel configuration (honest state — spec §28: never fake configured) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">Firebase (FCM)</CardTitle>
            <CardDescription>Primary push transport — Firebase Cloud Messaging.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading || !fcm ? (
              <Skeleton className="h-14 w-full" />
            ) : fcmReady ? (
              <div className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" aria-hidden />
                <div>
                  <div className="font-medium">Configured — project {fcm.projectId}</div>
                  <div className="text-xs text-muted-foreground">
                    Channel {fcm.toggleOn ? "enabled" : "disabled"} (Settings → Automation → Push notifications).
                  </div>
                </div>
              </div>
            ) : (
              <Alert>
                <ShieldAlert className="h-4 w-4" aria-hidden />
                <AlertTitle>Not configured</AlertTitle>
                <AlertDescription className="text-xs">
                  Add the Firebase service account + web client credentials to the server environment
                  (FIREBASE_SERVICE_ACCOUNT, FIREBASE_CLIENT_* keys, FIREBASE_VAPID_KEY) and enable
                  “Push notifications” under Automation. Devices will register automatically once configured.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Legacy web-push (VAPID)</CardTitle>
            <CardDescription>Fallback transport for previously registered browsers.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {overview?.channels.vapid.configured ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden /> Configured
              </div>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground">
                <XCircle className="h-4 w-4" aria-hidden /> Not configured
              </div>
            )}
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border p-2">
                <div className="text-lg font-semibold">{overview?.devices.fcmActive ?? "—"}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">FCM active</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-lg font-semibold">{overview?.devices.vapidActive ?? "—"}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">VAPID active</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-lg font-semibold">{overview?.deliveries7d.sent ?? "—"}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Sent 7d</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Test sender (spec §31) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" aria-hidden /> Send test notification
          </CardTitle>
          <CardDescription>Sends a real push through the production pipeline and reports the actual result.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="push-test-user">Recipient</Label>
              <Select value={userId} onValueChange={onUserSelected}>
                <SelectTrigger id="push-test-user" aria-label="Select recipient">
                  <SelectValue placeholder="Select user…" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name || u.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="push-test-device">Device</Label>
              <Select
                value={deviceId}
                onValueChange={setDeviceId}
                disabled={!devices || devices.filter((d) => d.active).length === 0}
              >
                <SelectTrigger id="push-test-device" aria-label="Select device">
                  <SelectValue placeholder={devices ? (devices.some((d) => d.active) ? "All active devices" : "No active devices") : "Select a user first…"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEVICE_ALL}>All active devices</SelectItem>
                  {(devices ?? []).filter((d) => d.active).map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label} ({d.kind})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="push-test-title">Title</Label>
              <Input id="push-test-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="push-test-body">Message</Label>
              <Input id="push-test-body" value={body} maxLength={300} onChange={(e) => setBody(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={onSendTest} disabled={!userId || sending || (devices !== null && !devices.some((d) => d.active))}>
              {sending ? <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" aria-hidden /> : <Send className="h-4 w-4 mr-1.5" aria-hidden />}
              Send Test Notification
            </Button>
            {result ? (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                {result.status === "SENT" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" aria-hidden />
                )}
                {resultSummary}
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Recent deliveries (§30) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <BellRing className="h-4 w-4 text-primary" aria-hidden /> Recent deliveries
            </span>
            <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
            </Button>
          </CardTitle>
          <CardDescription>
            Last 20 push deliveries. Queued {overview?.deliveries7d.queued ?? 0} · Sent {overview?.deliveries7d.sent ?? 0} ·
            Failed {overview?.deliveries7d.failed ?? 0} · Dead-letter {overview?.deliveries7d.deadLettered ?? 0} · Skipped {overview?.deliveries7d.skipped ?? 0} (7 days)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : (overview?.recent.length ?? 0) === 0 ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2 py-2">
              <Smartphone className="h-4 w-4" aria-hidden /> No push deliveries yet.
            </div>
          ) : (
            <ul className="divide-y rounded-md border max-h-96 overflow-y-auto">
              {(overview?.recent ?? []).map((r) => (
                <li key={r.id} className="flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{r.title}</span>
                      {r.isTest ? <Badge variant="outline" className="text-[10px] shrink-0">TEST</Badge> : null}
                      {statusBadge(r.status)}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {r.userName} · {r.channel} · {r.priority} · devices {r.sentCount}/{r.deviceCount} ok
                      {r.failedCount ? `, ${r.failedCount} failed` : ""}{r.skippedCount ? `, ${r.skippedCount} skipped` : ""}
                      · {new Date(r.createdAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </div>
                    {r.lastError ? <div className="text-xs text-destructive/80 truncate mt-0.5">{r.errorCode ? `${r.errorCode}: ` : ""}{r.lastError}</div> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
