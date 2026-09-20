"use client";

// MOHD.HMS ENTERPRISE — Idle session guard (inactivity auto-logout UX).
//
// The SERVER is authoritative: it invalidates the session when the reported
// user activity is older than SESSION_IDLE_TIMEOUT_SECONDS and answers
// 401 SESSION_EXPIRED. This component is the UX layer on top of that:
//
//   • Tracks GENUINE user interaction (pointer, keys, touch, wheel/scroll,
//     navigation) with throttled handling — never per-mousemove API calls.
//   • Reports activity to POST /api/v1/auth/activity at most once per
//     PING_INTERVAL — background polling/heartbeat/WS traffic never calls
//     it, so it can never keep an idle session alive (§8/§25).
//   • Shows the warning dialog at min(30s, 40% of the timeout) before expiry
//     ("Continue Session" = a real user interaction; nothing is extended
//     automatically) and performs the auto-logout at the deadline using the
//     EXISTING /api/v1/auth/logout endpoint.
//   • Wall-clock based (Date.now deltas): browser/PWA timer throttling while
//     backgrounded cannot desync it — the moment the user returns, the true
//     idle time is evaluated and the server validates the session anyway.
//   • Cross-tab: an idle logout is broadcast so every open tab signs out.
//
// Mounted once inside the authenticated shell (shell.tsx).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { clearLastRoute } from "@/lib/hms/pwa";
import { ROUTE_EVENT } from "@/lib/hms/router";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Clock, Loader2, LogOut } from "lucide-react";

const CHANNEL_NAME = "hms-session-bus";
/** Activity-ping frequency cap: at most one server report per interval. */
const PING_INTERVAL_MS = 20_000;

export function IdleSessionGuard() {
  const { user, idleTimeoutSeconds, signOut } = useSession();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [busy, setBusy] = useState(false);

  const lastActivityRef = useRef<number>(Date.now());
  const lastPingRef = useRef<number>(0);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const signedOutRef = useRef(false);

  const timeoutMs = (idleTimeoutSeconds ?? 300) * 1000;
  /** 300s → warning at 4:30 (30s left). Short test timeouts warn earlier. */
  const warnAtMs = Math.min(30_000, Math.floor(timeoutMs * 0.4));

  /** Tell the server about genuine user activity (throttled, fire-and-forget).
   *  A SESSION_EXPIRED answer means the server already killed the session. */
  const reportActivity = useCallback((force = false) => {
    const now = Date.now();
    if (!force && now - lastPingRef.current < PING_INTERVAL_MS) return;
    lastPingRef.current = now;
    api.post("/api/v1/auth/activity").catch((e) => {
      if (e instanceof ClientApiError && e.code === "SESSION_EXPIRED") {
        // Server already enforced the timeout — its central handler takes over.
      }
    });
  }, []);

  /** One shared cleanup for local (in)activity expiry across the tab. */
  const performLogout = useCallback(
    async (opts: { broadcast: boolean; serverLogout: boolean; notifyExpired: boolean }) => {
      if (signedOutRef.current) return;
      signedOutRef.current = true;
      setSecondsLeft(null);
      if (opts.serverLogout) {
        await api
          .post("/api/v1/auth/logout", opts.notifyExpired ? { reason: "idle" } : undefined)
          .catch(() => undefined);
      }
      clearLastRoute();
      if (opts.broadcast) {
        try {
          bcRef.current?.postMessage({ type: "session-expired" });
        } catch { /* channel may be closed */ }
      }
      // Clear auth state — the Gate renders the auth flow; a full navigation
      // to the login screen also tears down the WebSocket, polls and caches.
      if (opts.notifyExpired) {
        try { sessionStorage.setItem("hms_session_expired_notice", "1"); } catch { /* best effort */ }
      }
      await signOut();
      if (window.location.pathname !== "/") window.location.assign("/?auth=login");
    },
    [signOut]
  );

  // Cross-tab bus (§10): when any tab performs the idle logout, every other
  // tab signs out too. No separate sync system — one BroadcastChannel.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(CHANNEL_NAME);
    bcRef.current = bc;
    bc.onmessage = (ev: MessageEvent) => {
      if (ev.data?.type === "session-expired") {
        void performLogout({ broadcast: false, serverLogout: false, notifyExpired: false });
      }
    };
    return () => {
      bc.close();
      bcRef.current = null;
    };
  }, [performLogout]);

  // Reset the local clock on genuine user activity. Server reports are
  // throttled separately; the local timer reset is free.
  useEffect(() => {
    if (!user) return;
    const touch = () => {
      lastActivityRef.current = Date.now();
      setSecondsLeft((s) => (s === null ? s : null)); // dismiss the warning on activity
      reportActivity(false);
    };
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    const events: [string, EventTarget][] = [
      ["pointermove", window], ["pointerdown", window], ["click", window],
      ["keydown", window], ["touchstart", window], ["wheel", window],
      ["scroll", window], ["popstate", window], [ROUTE_EVENT, window],
    ];
    for (const [name, target] of events) {
      target.addEventListener(name, touch, opts);
    }
    return () => {
      for (const [name, target] of events) {
        target.removeEventListener(name, touch, opts);
      }
    };
  }, [user?.id, reportActivity]);

  // Wall-clock state machine — 1s tick + immediate evaluation when the tab
  // becomes visible again (PWA backgrounding must not miss the deadline).
  useEffect(() => {
    if (!user || !idleTimeoutSeconds) return;
    signedOutRef.current = false;
    lastActivityRef.current = Date.now();
    lastPingRef.current = Date.now();

    const evaluate = () => {
      const idleMs = Date.now() - lastActivityRef.current;
      if (idleMs >= timeoutMs) {
        void performLogout({ broadcast: true, serverLogout: true, notifyExpired: true });
        return;
      }
      if (idleMs >= timeoutMs - warnAtMs) {
        setSecondsLeft(Math.max(1, Math.ceil((timeoutMs - idleMs) / 1000)));
      }
    };

    const tick = setInterval(evaluate, 1000);
    const onVisible = () => { if (document.visibilityState === "visible") evaluate(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      setSecondsLeft(null);
    };
  }, [user?.id, idleTimeoutSeconds, timeoutMs, warnAtMs, performLogout]);

  if (!user) return null;

  async function continueSession() {
    setBusy(true);
    try {
      // A REAL user interaction: reset the local clock and report it so the
      // server's lastActivityAt advances (never done automatically).
      lastActivityRef.current = Date.now();
      lastPingRef.current = 0;
      reportActivity(true);
      setSecondsLeft(null);
    } finally {
      setBusy(false);
    }
  }

  const warningOpen = secondsLeft !== null;

  return (
    <Dialog
      open={warningOpen}
      onOpenChange={(o) => {
        // Closing the dialog (Esc/overlay) counts as wanting to stay — keep
        // the session ONLY via the explicit Continue button, which resets the
        // clock. Simply closing leaves the countdown running (honest UX).
        if (!o) return;
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="idle-warning-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-amber-600" aria-hidden />
            Session about to expire
          </DialogTitle>
          <DialogDescription>
            Your session will expire in <strong data-testid="idle-countdown">{secondsLeft}</strong> seconds due to inactivity.
            Continue the session to keep working — unsaved drafts are preserved either way.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
          <Button
            variant="outline"
            onClick={() => void performLogout({ broadcast: true, serverLogout: true, notifyExpired: false })}
            disabled={busy || signingOut}
            data-testid="idle-logout-now"
          >
            {signingOut ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <LogOut className="h-4 w-4 mr-2" aria-hidden />}
            Logout Now
          </Button>
          <Button onClick={continueSession} disabled={busy} data-testid="idle-continue-session">
            Continue Session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
