"use client";

// MOHD.HMS ENTERPRISE — PWA menu affordances (notification bell + user menu).
//  • PushNotificationRow: opt-in Web Push for this device. The UI reflects
//    REAL state only (§41): unsupported → hidden, blocked → hint, off → Enable,
//    on → On with a way to turn it off.
//  • InstallMenuItem: native install flow entry point in the user menu; only
//    rendered when the browser has reported installability.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, BellOff, BellRing } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  disablePush, enablePush, fetchPushStatus, getPwaState, promptInstall, subscribePwa, type PushStatus,
} from "@/lib/hms/pwa";

type PushUiState = {
  status: PushStatus | null; // null = loading
  busy: boolean;
};

export function PushNotificationRow() {
  const { toast } = useToast();
  const [ui, setUi] = useState<PushUiState>({ status: null, busy: false });

  useEffect(() => {
    let cancelled = false;
    void fetchPushStatus().then((s) => {
      if (!cancelled) setUi({ status: s, busy: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ui.status) return null; // still probing — render nothing (no flicker)
  const { status } = ui;
  // Hidden entirely when push can't work here (no support / server unconfigured
  // / previously blocked by the user — re-enabling requires browser settings).
  const hide =
    !status.pushEnabled ||
    status.permission === "unsupported" ||
    status.permission === "denied";
  if (hide) return null;

  async function onEnable() {
    setUi((s) => ({ ...s, busy: true }));
    const res = await enablePush();
    if (res.ok) {
      toast({ title: "Notifications enabled", description: "You'll receive operational alerts on this device." });
      const fresh = await fetchPushStatus();
      setUi({ status: fresh, busy: false });
    } else {
      toast({ title: "Couldn't enable notifications", description: res.error, variant: "destructive" });
      setUi((s) => ({ ...s, busy: false }));
    }
  }

  async function onDisable() {
    setUi((s) => ({ ...s, busy: true }));
    await disablePush();
    const fresh = await fetchPushStatus();
    setUi({ status: fresh, busy: false });
    toast({ title: "Notifications turned off", description: "This device will no longer receive push alerts." });
  }

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 border-t bg-muted/30">
      <span className="flex items-center gap-2 min-w-0 text-xs text-muted-foreground">
        {status.subscribed ? (
          <BellRing className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        ) : (
          <BellOff className="h-4 w-4 shrink-0" aria-hidden />
        )}
        <span className="truncate">
          {status.subscribed ? "Push notifications are on for this device" : "Get push alerts on this device"}
        </span>
      </span>
      {status.subscribed ? (
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onDisable} disabled={ui.busy}>
          {ui.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Turn off
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onEnable} disabled={ui.busy}>
          {ui.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Enable
        </Button>
      )}
    </div>
  );
}

/** User-menu install entry; null when not installable / already installed. */
export function useInstallable(): boolean {
  const [installable, setInstallable] = useState<boolean>(() => getPwaState().installable && !getPwaState().standalone);
  useEffect(
    () =>
      subscribePwa((s) => {
        setInstallable(s.installable && !s.standalone);
      }),
    []
  );
  return installable;
}

export async function startInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  return promptInstall();
}
