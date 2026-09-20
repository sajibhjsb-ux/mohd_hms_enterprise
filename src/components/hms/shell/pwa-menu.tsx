"use client";

// MOHD.HMS ENTERPRISE — PWA menu affordances (notification bell + user menu).
//  • PushNotificationRow: opt-in push notifications for this device. The UI
//    reflects REAL state only (§41): unsupported → hidden, blocked → hint,
//    off → Enable, on → On with a way to turn it off.
//    Enabling opens a contextual permission dialog FIRST (spec §18) — the
//    browser prompt is never triggered from a cold page load without context.
//    Transport selection is automatic: Firebase (FCM) when configured, else
//    legacy VAPID web-push (same row, same flow).
//  • InstallMenuItem: native install flow entry point in the user menu; only
//    rendered when the browser has reported installability.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, BellOff, BellRing, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  disablePush, enablePush, fetchPushStatus, getPwaState, promptInstall, subscribePwa, type PushStatus,
} from "@/lib/hms/pwa";

type PushUiState = {
  status: PushStatus | null; // null = loading
  busy: boolean;
  askOpen: boolean;
  blockedHint: boolean;
};

export function PushNotificationRow() {
  const { toast } = useToast();
  const [ui, setUi] = useState<PushUiState>({ status: null, busy: false, askOpen: false, blockedHint: false });

  useEffect(() => {
    let cancelled = false;
    void fetchPushStatus().then((s) => {
      if (!cancelled) setUi((u) => ({ ...u, status: s, busy: false }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ui.status) return null; // still probing — render nothing (no flicker)
  const { status } = ui;
  // Hidden entirely when push can't work here (no support / server unconfigured
  // / previously blocked by the user — re-enabling requires browser settings).
  const hide = !canEnable(status);
  if (hide) return null;

  function openAsk() {
    setUi((s) => ({ ...s, askOpen: true }));
  }

  async function onEnable() {
    setUi((s) => ({ ...s, askOpen: false, busy: true }));
    const res = await enablePush();
    if (res.ok) {
      toast({ title: "Notifications enabled", description: "You'll receive operational alerts on this device." });
    } else if (res.error?.toLowerCase().includes("permission")) {
      setUi((s) => ({ ...s, busy: false, blockedHint: true, askOpen: true }));
      return;
    } else {
      toast({ title: "Couldn't enable notifications", description: res.error, variant: "destructive" });
    }
    const fresh = await fetchPushStatus();
    setUi({ status: fresh, busy: false, askOpen: false, blockedHint: false });
  }

  async function onDisable() {
    setUi((s) => ({ ...s, busy: true }));
    await disablePush();
    const fresh = await fetchPushStatus();
    setUi({ status: fresh, busy: false, askOpen: false, blockedHint: false });
    toast({ title: "Notifications turned off", description: "This device will no longer receive push alerts." });
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 border-t bg-muted/30">
        <span className="flex items-center gap-2 min-w-0 text-xs text-muted-foreground">
          {status.subscribed || status.devices > 0 ? (
            <BellRing className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          ) : (
            <BellOff className="h-4 w-4 shrink-0" aria-hidden />
          )}
          <span className="truncate">
            {status.subscribed || status.devices > 0
              ? "Push notifications are on for this device"
              : "Get push alerts on this device"}
          </span>
        </span>
        {status.subscribed || status.devices > 0 ? (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onDisable} disabled={ui.busy}>
            {ui.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Turn off
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openAsk} disabled={ui.busy}>
            {ui.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} Enable
          </Button>
        )}
      </div>

      {/* Contextual permission flow (spec §18) — explain BEFORE the browser prompt. */}
      <Dialog open={ui.askOpen} onOpenChange={(open) => setUi((s) => ({ ...s, askOpen: open }))}>
        <DialogContent className="sm:max-w-md">
          {ui.blockedHint ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden /> Notifications are blocked in your browser
                </DialogTitle>
                <DialogDescription>
                  To re-enable, open the padlock / site-settings icon in your browser&apos;s address bar,
                  set <strong>Notifications</strong> to <strong>Allow</strong>, then reload this page.
                  The app will never repeatedly re-ask after a block.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setUi((s) => ({ ...s, askOpen: false, blockedHint: false }))}>
                  Got it
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <BellRing className="h-5 w-5 text-primary" aria-hidden /> Enable Notifications
                </DialogTitle>
                <DialogDescription>
                  Receive important work orders, complaints, invoices and system updates —
                  even when this app is in the background. You can turn this off anytime.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" onClick={() => setUi((s) => ({ ...s, askOpen: false }))}>
                  Not Now
                </Button>
                <Button onClick={onEnable} disabled={ui.busy}>
                  {ui.busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : null}
                  Enable Notifications
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Enable is meaningful when any transport exists AND the browser can ask. */
function canEnable(status: PushStatus): boolean {
  if (status.permission === "unsupported") return false;
  if (status.permission === "denied") return false; // re-enable requires browser settings
  return status.fcm.configured || status.pushEnabled;
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
