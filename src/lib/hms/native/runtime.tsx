"use client";

// MOHD.HMS ENTERPRISE — native shell runtime (mounted once inside the session
// provider). Wires ONLY the native capabilities that replace a browser API:
// status bar, splash hand-off, connectivity, resume, push binding and
// notification/app-link routing. Routing itself stays in src/lib/hms/router.

import { useEffect, useRef } from "react";
import { useSession } from "@/components/hms/session";
import { isNativeApp, nativePlatform } from "./platform";
import { sanitizeAppPath } from "./deep-link";

async function navigatePath(path: string): Promise<void> {
  const { parsePath, navigateTo } = await import("@/lib/hms/router");
  const parsed = parsePath(path);
  if (!parsed) return;
  const query = Object.fromEntries(new URLSearchParams(parsed.query));
  navigateTo(parsed.module, parsed.seg, Object.keys(query).length ? query : undefined);
}

export function NativeRuntime() {
  const { user } = useSession();
  const userId = user?.id ?? null;
  const userIdRef = useRef<string | null>(null);
  const previousUser = useRef<string | null>(null);
  const pendingLink = useRef<string | null>(null);
  userIdRef.current = userId;

  // A deep link opened while signed out is replayed after authentication.
  const openLink = (raw: unknown) => {
    const path = sanitizeAppPath(raw);
    if (!path) return;
    if (!userIdRef.current) {
      pendingLink.current = path;
      return;
    }
    void navigatePath(path);
  };
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;

  useEffect(() => {
    if (!isNativeApp()) return;
    let disposed = false;
    const cleanups: Array<() => void | Promise<void>> = [];

    const boot = async () => {
      const [{ App }, { Network }, { StatusBar, Style }, { SplashScreen }, { PushNotifications }] = await Promise.all([
        import("@capacitor/app"),
        import("@capacitor/network"),
        import("@capacitor/status-bar"),
        import("@capacitor/splash-screen"),
        import("@capacitor/push-notifications"),
      ]);
      if (disposed) return;

      // Native launch screen → existing branded loading splash.
      setTimeout(() => { SplashScreen.hide().catch(() => undefined); }, 250);

      StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
      if (nativePlatform() === "android") {
        StatusBar.setBackgroundColor({ color: "#0c2414" }).catch(() => undefined);
      }

      // Real connectivity (navigator.onLine is unreliable in WebViews).
      const applyNetwork = (connected: boolean) => {
        window.dispatchEvent(new Event(connected ? "online" : "offline"));
      };
      Network.getStatus().then((s) => applyNetwork(s.connected)).catch(() => undefined);
      const networkHandle = await Network.addListener("networkStatusChange", (s) => applyNetwork(s.connected));
      cleanups.push(() => networkHandle.remove());

      // App resumed: re-bind push (token refresh / user change), re-check
      // connectivity and ask existing subscribers to reconcile.
      const stateHandle = await App.addListener("appStateChange", ({ isActive }) => {
        if (!isActive) return;
        Network.getStatus().then((s) => applyNetwork(s.connected)).catch(() => undefined);
        const id = userIdRef.current;
        if (id) void import("./push").then((m) => m.initNativePush(id)).catch(() => undefined);
        void import("@/lib/hms/realtime/bus").then((m) => m.publishRealtimeResync("native-resume")).catch(() => undefined);
        window.dispatchEvent(new Event("hms:notifications-refresh"));
      });
      cleanups.push(() => stateHandle.remove());

      // Custom-scheme / verified app links (warm start).
      const urlHandle = await App.addListener("appUrlOpen", ({ url }) => openLinkRef.current(url));
      cleanups.push(() => urlHandle.remove());
      const launch = await App.getLaunchUrl().catch(() => null);
      if (launch?.url) setTimeout(() => openLinkRef.current(launch.url), 800);

      // Notification click (warm or cold start). Data payload carries the
      // server-computed in-app route; deep-link.ts validates it again.
      const actionHandle = await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
        const data = action.notification.data ?? {};
        openLinkRef.current(data.url ?? data.link);
        window.dispatchEvent(new Event("hms:notifications-refresh"));
      });
      cleanups.push(() => actionHandle.remove());
    };

    void boot().catch((err) => console.warn("native-runtime-init-failed", err));

    return () => {
      disposed = true;
      for (const off of cleanups) void off();
    };
  }, []);

  // Bind/unbind this installation to the signed-in account, and replay a deep
  // link that arrived before authentication completed.
  useEffect(() => {
    if (!isNativeApp()) return;
    if (userId) {
      void import("./push").then((m) => m.initNativePush(userId)).catch(() => undefined);
      const target = pendingLink.current;
      if (target) {
        pendingLink.current = null;
        void navigatePath(target);
      }
    } else if (previousUser.current) {
      // Session ended without an explicit sign-out (revocation/expiry):
      // delete the FCM token locally so the old account stops arriving.
      void import("./push").then((m) => m.disableNativePush({ server: false, plugin: true })).catch(() => undefined);
    }
    previousUser.current = userId;
  }, [userId]);

  return null;
}
