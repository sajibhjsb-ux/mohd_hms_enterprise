"use client";

// MOHD.HMS ENTERPRISE — Profile → Notifications (push devices + preferences).
// Spec §19/§32: registered device management + per-category push preferences
// inside the EXISTING profile architecture (no separate settings system).
// Real state only: the enable action reuses the one shared flow (FCM when the
// server is configured, legacy VAPID otherwise) with the §18 permission dialog.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Monitor, Smartphone, BellOff, BellRing, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/hms/api-client";
import { disablePush, enablePush, fetchPushStatus } from "@/lib/hms/pwa";

type DeviceRow = {
  id: string;
  kind: "FCM" | "VAPID";
  platform: string;
  deviceName: string | null;
  browser: string | null;
  operatingSystem: string | null;
  active: boolean;
  lastError: string;
  lastSeenAt: string | null;
  createdAt: string;
};

type CategoryRow = { key: string; label: string; push: boolean };

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function deviceLabel(d: DeviceRow): string {
  return [d.deviceName, d.browser, d.operatingSystem].filter(Boolean).join(" · ") || d.platform || "Device";
}

export function PushSettingsCards() {
  const { toast } = useToast();
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingCat, setSavingCat] = useState<string | null>(null);
  const [thisBrowserActive, setThisBrowserActive] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<DeviceRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [devRes, prefRes, status] = await Promise.all([
        api.get<{ devices: DeviceRow[]; legacy: DeviceRow[] }>("/api/v1/push/devices"),
        api.get<{ categories: CategoryRow[] }>("/api/v1/push/preferences"),
        fetchPushStatus(),
      ]);
      setDevices([...devRes.data.devices, ...devRes.data.legacy]);
      setCategories(prefRes.data.categories);
      setThisBrowserActive(status.subscribed || status.devices > 0);
    } catch {
      setDevices([]);
      setCategories([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onEnableThisBrowser() {
    setBusy(true);
    const res = await enablePush();
    if (res.ok) {
      toast({ title: "Notifications enabled", description: "You'll receive operational alerts on this device." });
    } else {
      toast({ title: "Couldn't enable notifications", description: res.error, variant: "destructive" });
    }
    await load();
    setBusy(false);
  }

  async function onDisableThisBrowser() {
    setBusy(true);
    await disablePush();
    toast({ title: "Notifications turned off", description: "This device will no longer receive push alerts." });
    await load();
    setBusy(false);
  }

  async function onRemoveConfirmed() {
    const d = confirmRemove;
    if (!d) return;
    setConfirmRemove(null);
    try {
      await api.del(`/api/v1/push/devices?id=${encodeURIComponent(d.id)}&kind=${d.kind}`);
      toast({ title: "Device removed", description: `${deviceLabel(d)} will no longer receive push notifications.` });
      await load();
    } catch (e) {
      toast({ title: "Remove failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  }

  async function onToggleCategory(cat: CategoryRow, value: boolean) {
    setSavingCat(cat.key);
    try {
      const res = await api.put<{ categories: CategoryRow[] }>("/api/v1/push/preferences", {
        preferences: { [cat.key]: { push: value } },
      });
      setCategories(res.data.categories);
    } catch (e) {
      toast({ title: "Could not save preference", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSavingCat(null);
    }
  }

  const activeDevices = (devices ?? []).filter((d) => d.active);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Registered devices (spec §32) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BellRing className="h-4 w-4 text-primary" aria-hidden /> Registered devices
          </CardTitle>
          <CardDescription>Devices that receive push notifications for your account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {devices === null ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : activeDevices.length === 0 ? (
            <div className="flex items-start gap-2 text-sm text-muted-foreground py-2">
              <BellOff className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
              <span>No devices registered yet. Enable notifications on this device to get started.</span>
            </div>
          ) : (
            <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {activeDevices.map((d) => (
                <li key={`${d.kind}-${d.id}`} className="flex items-center gap-3 rounded-md border p-2.5">
                  {/android|iphone|ipad|ios|mobile/i.test(`${d.platform} ${d.operatingSystem ?? ""}`) ? (
                    <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{deviceLabel(d)}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      Last seen: {fmtDate(d.lastSeenAt)} · Push: {d.active ? "Enabled" : "Off"}
                      {d.lastError ? ` · ${d.lastError}` : ""}
                    </div>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">{d.kind}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmRemove(d)}
                    aria-label={`Remove device ${deviceLabel(d)}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 border-t pt-3">
            {thisBrowserActive ? (
              <Button size="sm" variant="outline" onClick={onDisableThisBrowser} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden /> : null}
                Turn off on this device
              </Button>
            ) : (
              <Button size="sm" onClick={onEnableThisBrowser} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden /> : <BellRing className="h-4 w-4 mr-1.5" aria-hidden />}
                Enable on this device
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Notification preferences (spec §19) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BellRing className="h-4 w-4 text-primary" aria-hidden /> Push preferences
          </CardTitle>
          <CardDescription>Choose which updates reach your devices. In-app and email rules are unchanged.</CardDescription>
        </CardHeader>
        <CardContent>
          {categories === null ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : (
            <ul className="space-y-1 max-h-64 overflow-y-auto pr-1">
              {categories.map((cat) => (
                <li key={cat.key} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/40">
                  <span className="text-sm">{cat.label}</span>
                  <span className="flex items-center gap-2">
                    {savingCat === cat.key ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden /> : null}
                    <Switch
                      checked={cat.push}
                      onCheckedChange={(v) => void onToggleCategory(cat, v)}
                      disabled={savingCat === cat.key}
                      aria-label={`Push notifications for ${cat.label}`}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!confirmRemove} onOpenChange={(open) => (!open ? setConfirmRemove(null) : undefined)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove this device?</DialogTitle>
            <DialogDescription>
              {confirmRemove ? `${deviceLabel(confirmRemove)} will stop receiving push notifications. You can re-enable it anytime from that device.` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setConfirmRemove(null)}>Cancel</Button>
            <Button variant="destructive" onClick={onRemoveConfirmed}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
