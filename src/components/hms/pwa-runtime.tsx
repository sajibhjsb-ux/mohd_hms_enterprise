"use client";

// MOHD.HMS ENTERPRISE — PWA runtime UI (global, mounted once in the root layout).
//  • Offline pill (subtle, non-blocking) while the device has no network.
//  • "Synchronizing → complete" recovery indicator that also fires the
//    existing realtime resync (reconciliation stays PostgreSQL-driven).
//  • "New version available" dialog — activates the waiting service worker
//    only on explicit user consent; drafts auto-save locally so a refresh is
//    always safe for unsaved forms.
//  • One-time polite install hint when the browser reports installability.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useUi } from "@/lib/hms/ui-store";
import { applyUpdate, dismissInstall, getPwaState, initPwa, promptInstall, subscribePwa, type PwaState } from "@/lib/hms/pwa";
import { publishRealtimeResync } from "@/lib/hms/realtime/bus";
import { Download, RefreshCw, WifiOff } from "lucide-react";

export function PwaRuntime() {
  const { toast } = useToast();
  const [state, setState] = useState<PwaState>(() => getPwaState());
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const prevOfflineRef = useRef<boolean | null>(null);
  const recoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Service worker + install capture + online/offline wiring. The offline→
  // online edge is detected inside the subscription (event-driven, no
  // cascading render effects): recover via the existing realtime resync.
  useEffect(() => {
    const unsubscribe = subscribePwa((s) => {
      setState(s);
      const prev = prevOfflineRef.current;
      prevOfflineRef.current = s.offline;
      if (prev === true && s.offline === false) {
        setRecovering(true);
        try {
          publishRealtimeResync("online-recovery");
        } catch { /* realtime not mounted (e.g. login page) */ }
        window.dispatchEvent(new Event("hms:flush-drafts"));
        if (recoverTimer.current) clearTimeout(recoverTimer.current);
        recoverTimer.current = setTimeout(() => {
          setRecovering(false);
          toast({ title: "Synchronization complete", description: "You're up to date." });
        }, 2500);
      }
    });
    const init = initPwa();
    return () => {
      unsubscribe();
      init();
      if (recoverTimer.current) clearTimeout(recoverTimer.current);
    };
  }, [toast]);

  // One-time install hint (per dismissal; re-offered after 14 days).
  useEffect(() => {
    if (!state.installable || state.standalone) return;
    const t = setTimeout(() => {
      toast({
        title: "Install MOHD.HMS Enterprise",
        description: "Full-screen workspace, offline support and notifications.",
        action: (
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-8"
              onClick={async () => {
                await promptInstall();
              }}
            >
              <Download className="h-3.5 w-3.5 mr-1" aria-hidden /> Install
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => {
                dismissInstall();
              }}
            >
              Not now
            </Button>
          </div>
        ),
        duration: 12000,
      });
    }, 4000);
    return () => clearTimeout(t);
  }, [state.installable, state.standalone, toast]);

  const updateOpen = state.updateReady && !updateDismissed;

  return (
    <>
      {state.offline ? (
        <div
          role="status"
          aria-live="polite"
          className="no-print fixed left-4 bottom-20 lg:bottom-6 z-50 flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/80 dark:text-amber-200 px-3.5 py-2 text-xs font-medium shadow-lg backdrop-blur"
        >
          <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Offline — some features are unavailable. <span className="hidden sm:inline">Drafts are saved on this device.</span>
          </span>
        </div>
      ) : null}

      {recovering ? (
        <div
          role="status"
          aria-live="polite"
          className="no-print fixed left-4 bottom-20 lg:bottom-6 z-50 flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/80 dark:text-emerald-200 px-3.5 py-2 text-xs font-medium shadow-lg backdrop-blur"
        >
          <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
          <span>Back online — synchronizing…</span>
        </div>
      ) : null}

      {/* PWA update — user-consented activation; never mid-form (drafts persist) */}
      <Dialog open={updateOpen} onOpenChange={(o) => { if (!o) setUpdateDismissed(true); }}>
        <DialogContent className="sm:max-w-md" aria-describedby="pwa-update-desc">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-primary" aria-hidden /> New version available
            </DialogTitle>
            <DialogDescription id="pwa-update-desc">
              A new version of MOHD.HMS Enterprise is ready. Unsaved forms keep their drafts — they restore automatically after the update.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setUpdateDismissed(true)}>
              Later
            </Button>
            <Button
              onClick={() => {
                setUpdateDismissed(true);
                useUi.getState().setPageDirty(false);
                applyUpdate();
              }}
            >
              <RefreshCw className="h-4 w-4 mr-2" aria-hidden /> Refresh now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
