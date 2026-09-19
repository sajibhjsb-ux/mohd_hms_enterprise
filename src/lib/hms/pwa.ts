"use client";

// MOHD.HMS ENTERPRISE — client PWA runtime (service-worker lifecycle, install
// prompt, standalone detection). UI rendering lives in pwa-runtime.tsx.
//
// Guarantees:
//  - Registration is deferred until the page is idle (never competes with
//    first paint) and can be disabled with localStorage["hms:pwa:off"]="1"
//    (local development escape hatch).
//  - Updates NEVER activate automatically: the waiting worker is activated
//    only after the user presses Refresh, and unsaved form state is protected
//    because drafts auto-save to localStorage continuously (use-draft).
//  - Realtime (socket.io through the gateway) and /api/* are never intercepted
//    by the service worker (see public/sw.js isBypassed).

export type PwaState = {
  supported: boolean;
  standalone: boolean;
  installable: boolean;      // beforeinstallprompt captured, not dismissed
  updateReady: boolean;      // a waiting service worker exists
  offline: boolean;
  swActive: boolean;
};

type Listener = (state: PwaState) => void;

const DISMISS_KEY = "hms:pwa:install-dismissed-at";
const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000; // re-offer after 14 days
const KILL_SWITCH_KEY = "hms:pwa:off";

const g = globalThis as unknown as {
  __hmsPwa?: {
    state: PwaState;
    listeners: Set<Listener>;
    deferredPrompt: (Event & { prompt: () => Promise<void>; userChoice?: Promise<{ outcome: string }> }) | null;
    registration: ServiceWorkerRegistration | null;
    reloading: boolean;
  };
};

const store = (g.__hmsPwa ??= {
  state: {
    supported: false,
    standalone: false,
    installable: false,
    updateReady: false,
    offline: false,
    swActive: false,
  },
  listeners: new Set<Listener>(),
  deferredPrompt: null,
  registration: null,
  reloading: false,
});

function setState(patch: Partial<PwaState>) {
  store.state = { ...store.state, ...patch };
  for (const fn of store.listeners) fn(store.state);
}

export function getPwaState(): PwaState {
  return store.state;
}

export function subscribePwa(fn: Listener): () => void {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

function installDismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return at > 0 && Date.now() - at < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return window.matchMedia?.("(display-mode: standalone)")?.matches || iosStandalone;
}

export function dismissInstall(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch { /* storage unavailable */ }
  setState({ installable: false });
}

/** Trigger the browser's native install flow. Returns the user outcome. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = store.deferredPrompt;
  if (!ev) return "unavailable";
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    if (choice?.outcome === "accepted") setState({ installable: false });
    else dismissInstall();
    return choice?.outcome === "accepted" ? "accepted" : "dismissed";
  } catch {
    return "unavailable";
  } finally {
    store.deferredPrompt = null;
  }
}

/** Activate the waiting service worker (user consented via Refresh button). */
export function applyUpdate(): void {
  const waiting = store.registration?.waiting;
  if (!waiting) return;
  waiting.postMessage({ type: "SKIP_WAITING" });
  // controllerchange fires when the new worker takes over → reload once.
}

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  if (typeof localStorage !== "undefined" && localStorage.getItem(KILL_SWITCH_KEY) === "1") return;

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none", // update checks always hit the network
    });
    store.registration = registration;
    setState({ swActive: !!navigator.serviceWorker.controller });

    if (navigator.serviceWorker.controller) setState({ swActive: true });

    // Update detection: waiting worker + controller ⇒ a new version is ready.
    const checkWaiting = () => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        setState({ updateReady: true });
      }
    };
    checkWaiting();
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          setState({ updateReady: true });
        }
      });
    });

    // Re-check for updates when the app regains focus (quiet, network-light).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") registration.update().catch(() => undefined);
    });

    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      setState({ swActive: true, updateReady: false });
      if (reloaded || store.reloading) return;
      reloaded = true;
      store.reloading = true;
      window.location.reload();
    });

    // Notification-click routing from the service worker (existing router).
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data as { type?: string; url?: string } | undefined;
      if (data?.type === "hms:navigate" && typeof data.url === "string") {
        const target = new URL(data.url, window.location.origin);
        if (target.origin === window.location.origin) {
          window.history.pushState({}, "", target.pathname + target.search);
          window.dispatchEvent(new Event("hms:route"));
        }
      }
      if (data?.type === "hms:flush-drafts") {
        window.dispatchEvent(new Event("hms:flush-drafts"));
      }
    });
  } catch {
    // Service workers unavailable/blocked — the app keeps working as a website.
  }
}

/** Wire all browser events; returns a cleanup fn (idempotent, SSR-safe). */
export function initPwa(): () => void {
  if (typeof window === "undefined") return () => undefined;

  setState({ supported: "serviceWorker" in navigator, standalone: isStandalone(), offline: !navigator.onLine });

  const onOffline = () => setState({ offline: true });
  const onOnline = () => setState({ offline: false });
  const onInstallPrompt = (event: Event) => {
    event.preventDefault(); // keep our own install UX in control
    store.deferredPrompt = event as typeof store.deferredPrompt;
    setState({ installable: !installDismissedRecently() && !isStandalone() });
  };
  const onInstalled = () => {
    setState({ installable: false, standalone: isStandalone() });
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* noop */ }
  };
  const onDisplayChange = (e: MediaQueryListEvent) => setState({ standalone: e.matches });

  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  window.addEventListener("beforeinstallprompt", onInstallPrompt);
  window.addEventListener("appinstalled", onInstalled);
  window.matchMedia?.("(display-mode: standalone)")?.addEventListener?.("change", onDisplayChange);

  // Deferred registration — PWA must never slow down first paint (spec §25).
  const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number; setTimeout: typeof window.setTimeout; cancelIdleCallback?: (id: number) => void };
  const idleId: number =
    typeof w.requestIdleCallback === "function"
      ? w.requestIdleCallback(() => { void registerServiceWorker(); })
      : w.setTimeout(() => { void registerServiceWorker(); }, 1500);

  return () => {
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("beforeinstallprompt", onInstallPrompt);
    window.removeEventListener("appinstalled", onInstalled);
    if (typeof w.cancelIdleCallback === "function") {
      w.cancelIdleCallback(idleId);
    } else {
      clearTimeout(idleId as unknown as ReturnType<typeof setTimeout>);
    }
  };
}

/* ───────────────────────── Web Push (client half) ─────────────────────── */

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushStatus = {
  pushEnabled: boolean;        // server has VAPID configured
  publicKey?: string;
  subscribed: boolean;         // this browser has an active subscription
  permission: NotificationPermission | "unsupported";
};

export async function fetchPushStatus(): Promise<PushStatus> {
  const permission: NotificationPermission | "unsupported" =
    typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  let endpoint: string | undefined;
  try {
    if ("serviceWorker" in navigator) {
      const reg = store.registration ?? (await navigator.serviceWorker.ready);
      endpoint = (await reg.pushManager.getSubscription())?.endpoint;
    }
  } catch { /* SW not ready */ }
  try {
    const { api } = await import("@/lib/hms/api-client");
    const res = await api.get<{ enabled: boolean; publicKey?: string; subscribed: boolean }>(
      "/api/v1/push/status" + (endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : "")
    );
    return { pushEnabled: res.data.enabled, publicKey: res.data.publicKey, subscribed: res.data.subscribed, permission };
  } catch {
    return { pushEnabled: false, subscribed: false, permission };
  }
}

/** Ask the user, subscribe this browser, and register the device server-side. */
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (typeof Notification === "undefined") return { ok: false, error: "This browser does not support notifications." };
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, error: "Notification permission was not granted." };

    const status = await fetchPushStatus();
    if (!status.pushEnabled || !status.publicKey) return { ok: false, error: "Push is not configured on the server yet." };
    if (!("serviceWorker" in navigator)) return { ok: false, error: "Service worker is not available." };

    const registration = store.registration ?? (await navigator.serviceWorker.ready);
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.publicKey) as unknown as BufferSource,
      }));

    const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    const { api } = await import("@/lib/hms/api-client");
    await api.post("/api/v1/push/subscribe", {
      endpoint: json.endpoint,
      keys: json.keys,
      deviceName: (navigator as unknown as { platform?: string }).platform || undefined,
      platform:
        uaData?.platform ??
        (/Android/i.test(navigator.userAgent) ? "Android" : /iPhone|iPad/i.test(navigator.userAgent) ? "iOS" : undefined),
      browser: /Edg\//.test(navigator.userAgent) ? "Edge" : /Chrome\//.test(navigator.userAgent) ? "Chrome" : /Firefox\//.test(navigator.userAgent) ? "Firefox" : /Safari\//.test(navigator.userAgent) ? "Safari" : undefined,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not enable notifications." };
  }
}

/** Remove this browser's subscription locally and on the server. */
export async function disablePush(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const registration = store.registration ?? (await navigator.serviceWorker.ready);
      const sub = await registration.pushManager.getSubscription();
      const endpoint = sub?.endpoint;
      if (sub) await sub.unsubscribe();
      if (endpoint) {
        const { api } = await import("@/lib/hms/api-client");
        await api.del("/api/v1/push/subscribe?endpoint=" + encodeURIComponent(endpoint)).catch(() => undefined);
      }
    }
  } catch { /* best-effort */ }
}

/** Register a background-sync flush for locally saved drafts (where supported). */
export async function requestDraftSync(): Promise<void> {
  try {
    const registration = (navigator.serviceWorker && (store.registration ?? (await navigator.serviceWorker.ready))) as
      | (ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } })
      | null;
    await registration?.sync?.register("hms-draft-flush");
  } catch { /* Background Sync unsupported — online-flush covers it */ }
}
