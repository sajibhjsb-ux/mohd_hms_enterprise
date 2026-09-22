"use client";

// MOHD.HMS ENTERPRISE — Settings → Notifications → Gateway health card.
//
// Aggregated health summary for the centralized Notification Gateway (§43):
// transport channel status (email SMTP/Resend, WhatsApp gateway, FCM/VAPID,
// realtime service), queue depths and recent delivery failures. All values
// come from /api/v1/notifications/admin/overview (server-side gated by
// settings.read) — no client-side guessing.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export type GatewayOverview = {
  channels: {
    email: { configured: boolean; provider: string; lastVerified: boolean };
    whatsapp: { configured: boolean; enabled: boolean; session: string; lastConnectedAt: string | null; lastOutboundAt: string | null; lastError: string | null };
    push: { fcm: boolean; vapidConfigured: boolean; clientReady: boolean };
    realtime: { online: boolean; clients: number };
  };
  queue: {
    notifications: { total: number; unread: number; last24h: number };
    push: Record<string, number>;
    email: { queued: number; retrying: number };
    realtimeOutbox: number;
  };
  recentErrors: Array<{ id: string; status: string; channel: string; errorCode: string; lastError: string | null; title: string; updatedAt: string }>;
};

function Row({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok === null ? (
        <Loader2 className="h-4 w-4 mt-0.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : ok ? (
        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" aria-hidden />
      ) : (
        <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" aria-hidden />
      )}
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground truncate">{detail}</div>
      </div>
    </div>
  );
}

export function GatewayHealthCard() {
  const { toast } = useToast();
  const [data, setData] = useState<GatewayOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<GatewayOverview>("/api/v1/notifications/admin/overview");
      setData(res.data);
    } catch (e) {
      toast({ title: "Failed to load gateway health", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const c = data?.channels;
  const q = data?.queue;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">Notification Gateway · Health</span>
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={load} disabled={loading} aria-label="Refresh gateway health">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          </Button>
        </CardTitle>
        <CardDescription>Central delivery pipeline: in-app, push, email, WhatsApp + realtime fan-out.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading || !c ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="rounded-md border p-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">Notifications (30d lifetime)</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {q?.notifications?.total ?? 0}
                    <span className="text-xs font-normal text-muted-foreground ml-1">· {q?.notifications?.unread ?? 0} unread</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">{q?.notifications?.last24h ?? 0} in last 24h</div>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">INBOX</Badge>
              </div>
              <div className="rounded-md border p-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">Delivery queues</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {(q?.push?.QUEUED ?? 0) + (q?.email?.queued ?? 0) + (q?.realtimeOutbox ?? 0)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    push {q?.push?.QUEUED ?? 0} · email {q?.email?.queued ?? 0} · realtime {q?.realtimeOutbox ?? 0}
                  </div>
                </div>
                <Badge variant="outline" className={`text-[10px] shrink-0 ${(q?.push?.FAILED ?? 0) + (q?.email?.retrying ?? 0) > 0 ? "text-amber-600" : ""}`}>QUEUE</Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="rounded-md border p-3 space-y-2">
                <Row ok={c.email.configured} label="Email" detail={c.email.configured ? `${c.email.provider} · ${c.email.lastVerified ? "verified" : "not verified"}` : "SMTP/Resend not configured"} />
                <Row ok={c.whatsapp.configured} label="WhatsApp" detail={c.whatsapp.configured ? `session ${c.whatsapp.session || "unknown"}` : "Gateway not configured"} />
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <Row ok={c.push.fcm} label="Push (FCM)" detail={c.push.fcm ? (c.push.clientReady ? "client ready" : "client not ready") : "Firebase not configured"} />
                <Row ok={c.realtime.online} label="Realtime" detail={c.realtime.online ? `${c.realtime.clients} client(s) connected` : "service offline"} />
              </div>
            </div>

            {(data?.recentErrors?.length ?? 0) > 0 && (
              <div className="rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-amber-700 mb-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Recent delivery failures
                </div>
                <ul className="space-y-1">
                  {data!.recentErrors.slice(0, 3).map((e) => (
                    <li key={e.id} className="flex items-center gap-2 justify-between">
                      <span className="truncate text-muted-foreground">{e.channel} · {e.title}</span>
                      <span className="shrink-0 tabular-nums">{e.errorCode || "ERROR"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}