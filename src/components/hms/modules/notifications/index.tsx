"use client";

// MOHD.HMS ENTERPRISE — Notifications module (route /notifications).
//
// Full history page for the centralized Notification Gateway (§43): every
// in-app / push / email / WhatsApp notification delivered to the signed-in
// user, with unread/read filters, per-item and bulk read actions, cursor
// pagination, realtime badge/list updates, and deep links to the originating
// record (same RESOURCE_ROUTES table the header dropdown uses).
//
// Reuse policy: this page consumes the SAME endpoints and storage as every
// other surface (header dropdown, realtime dispatcher, notification service).
// There is no second notification system.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BellRing, Check, CheckCheck, Filter, Inbox, Info, Loader2,
  AlertTriangle, CheckCircle2, RefreshCw,
} from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate, fmtTime } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { RT } from "@/lib/hms/realtime/matrix";
import { RESOURCE_ROUTES, navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/hms/shared/ui-bits";

type NotifItem = {
  id: string;
  channel: string;
  type: string;
  title: string;
  message: string;
  route: string | null;
  resourceType: string | null;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
};

type ApiMeta = { unread?: number | string; total?: number | string; hasMore?: boolean; nextCursor?: string };

const PAGE_SIZE = 20;
const typeIcon = (type: string) =>
  type === "WARNING" ? <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
  : type === "ERROR" ? <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
  : type === "SUCCESS" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />
  : <Info className="h-4 w-4 text-teal-500" aria-hidden />;

export function NotificationsModule() {
  const { toast } = useToast();
  const [rows, setRows] = useState<NotifItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(
    async (reset: boolean) => {
      if (reset) {
        setLoading(true);
        setError(null);
      } else setLoadingMore(true);
      try {
        const params = qs({
          take: PAGE_SIZE,
          ...(reset ? {} : cursor ? { cursor } : {}),
          ...(tab === "unread" ? { unread: "1" } : {}),
        });
        const res = await api.get<NotifItem[]>(`/api/v1/notifications${params}`);
        const meta = (res.meta ?? {}) as ApiMeta;
        setTotal(Number(meta.total ?? res.data.length));
        setUnread(Number(meta.unread ?? 0));
        setRows((prev) => (reset ? res.data : [...prev, ...res.data]));
        setCursor(typeof meta.nextCursor === "string" ? meta.nextCursor : undefined);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to load notifications.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [cursor, tab]
  );

  useEffect(() => {
    setLoading(true);
    setRows([]);
    setCursor(undefined);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, refreshKey]);

  // Realtime: new notification toasts nothing here (header owns that), but the
  // list/badge refresh immediately.
  useRealtimeEvent([RT.NOTIFICATION_CREATED, RT.NOTIFICATION_READ], () => {
    void load(true);
  });

  const openNotification = (n: NotifItem) => {
    if (!n.resourceId) return;
    const route = RESOURCE_ROUTES[n.resourceType ?? ""];
    if (route) navigateTo(route.module, route.seg(n.resourceId));
  };

  async function markRead(id: string) {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const res = await api.patch<{ unread: number }>("/api/v1/notifications", { ids: [id] });
      if (typeof res.data?.unread === "number") setUnread(res.data.unread);
      setRows((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    } catch {
      toast({ title: "Unable to mark notification as read", variant: "destructive" });
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  async function markAllRead() {
    if (unread === 0 || markingAll) return;
    setMarkingAll(true);
    try {
      await api.patch("/api/v1/notifications/read-all", {});
      setUnread(0);
      setRows((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
      void load(true);
    } catch {
      toast({ title: "Unable to mark notifications as read", variant: "destructive" });
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 min-h-[60vh]">
      <PageHeader
        title="Notifications"
        subtitle="History across in-app, push, email and WhatsApp — click an item to open the related record."
        actions={
          <Button variant="outline" size="sm" onClick={markAllRead} disabled={markingAll || unread === 0}>
            {markingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <CheckCheck className="h-4 w-4 mr-2" aria-hidden />}
            {markingAll ? "Marking…" : `Mark all read${unread ? ` (${unread})` : ""}`}
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as "all" | "unread")} className="mb-6">
        <TabsList className="gap-0">
          <TabsTrigger value="all" className="gap-2">
            <BellRing className="h-4 w-4" aria-hidden /> All
            <Badge variant="secondary" className="ml-0.5 rounded-full px-1.5 tabular-nums">{total}</Badge>
          </TabsTrigger>
          <TabsTrigger value="unread" className="gap-2">
            <Inbox className="h-4 w-4" aria-hidden /> Unread
            <Badge variant="secondary" className="ml-0.5 rounded-full px-1.5 tabular-nums">{unread}</Badge>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {loading ? (
        <LoadingState rows={5} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load(true)} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={tab === "unread" ? "No unread notifications" : "No notifications yet"}
          hint="You're all caught up. New notifications appear here in real time."
          action={<Button variant="outline" size="sm" onClick={() => setRefreshKey((k) => k + 1)}><RefreshCw className="h-4 w-4 mr-2" aria-hidden /> Refresh</Button>}
        />
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((n) => {
              const busy = busyIds.has(n.id);
              return (
                <li key={n.id} className={cn("group flex items-start gap-3 rounded-lg border p-3.5 sm:p-4 transition-colors", !n.readAt && "bg-primary/5 border-primary/20")}>
                  <span className="mt-0.5 shrink-0">{typeIcon(n.type)}</span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                    onClick={() => openNotification(n)}
                    aria-disabled={!n.resourceId}
                    tabIndex={n.resourceId ? 0 : -1}
                  >
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{n.title}</span>
                      {n.channel !== "IN_APP" ? <Badge variant="outline" className="text-[10px]">{n.channel.replace(/_/g, " ")}</Badge> : null}
                      {!n.readAt ? <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="unread" /> : null}
                    </span>
                    <p className="text-sm text-muted-foreground mt-0.5">{n.message}</p>
                    <span className="text-[11px] text-muted-foreground/70 mt-1 block">
                      {fmtDate(n.createdAt)} · {fmtTime(n.createdAt)}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => markRead(n.id)}
                    disabled={!!n.readAt || busy}
                    aria-label={n.readAt ? "Already read" : "Mark as read"}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                  </Button>
                </li>
              );
            })}
          </ul>

          <div className="mt-6 flex items-center justify-center gap-3">
            {cursor && (
              <Button variant="outline" size="sm" onClick={() => void load(false)} disabled={loadingMore}>
                {loadingMore ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <Filter className="h-4 w-4 mr-2" aria-hidden />}
                Load more
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
              <RefreshCw className="h-4 w-4 mr-2" aria-hidden /> Refresh
            </Button>
          </div>
        </>
      )}
    </div>
  );
}