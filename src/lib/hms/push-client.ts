"use client";

// MOHD.HMS ENTERPRISE — Firebase Cloud Messaging (FCM) client half.
//
// Companion to pwa.ts (VAPID web-push client). ONE permission prompt, ONE
// service worker (public/sw.js), ONE registration flow:
//   enablePush() (pwa.ts) → fcmAvailable()? enableFcm() : legacy VAPID flow
//
// Design notes:
//   • The Firebase JS SDK is imported lazily and only when the server reports
//     a configured Firebase project — zero bundle cost otherwise.
//   • The public client config arrives from the server (/api/v1/push/status),
//     so ops can rotate it without a rebuild. These are PUBLIC identifiers;
//     no server credential is ever sent to the browser (spec §2/§25).
//   • getToken() binds the EXISTING /sw.js registration — no competing
//     firebase-messaging-sw.js (spec §4). Background messages are data-only,
//     so the SW's own push handler displays + routes them.
//   • Foreground messages do NOT raise a second OS notification (spec §16):
//     the realtime in-app UI already shows the same business notification;
//     this handler only nudges a refresh fallback if realtime is down.

export type FcmClientConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
  vapidKey: string;
};

export type FcmStatusBlock = {
  configured: boolean;
  projectId?: string;
  clientConfig?: FcmClientConfig;
};

export type ExtendedPushStatus = {
  pushEnabled: boolean; // legacy VAPID configured on the server
  publicKey?: string;
  subscribed: boolean;
  permission: NotificationPermission | "unsupported";
  fcm: FcmStatusBlock;
  devices: number;
};

const g = globalThis as unknown as {
  __hmsFcmClient?: {
    messaging: import("firebase/messaging").Messaging | null;
    initPromise: Promise<import("firebase/messaging").Messaging | null> | null;
    foregroundWired: boolean;
  };
};

function state() {
  g.__hmsFcmClient ??= { messaging: null, initPromise: null, foregroundWired: false };
  return g.__hmsFcmClient;
}

/** Ask the server for the full push status incl. the public FCM client config. */
export async function fetchExtendedPushStatus(): Promise<ExtendedPushStatus> {
  const permission: NotificationPermission | "unsupported" =
    typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  let endpoint: string | undefined;
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      endpoint = (await reg.pushManager.getSubscription())?.endpoint;
    }
  } catch { /* SW not ready */ }
  try {
    const { api } = await import("@/lib/hms/api-client");
    const res = await api.get<{
      enabled: boolean; publicKey?: string; subscribed: boolean;
      fcm?: FcmStatusBlock; devices?: number;
    }>("/api/v1/push/status" + (endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""));
    return {
      pushEnabled: res.data.enabled,
      publicKey: res.data.publicKey,
      subscribed: res.data.subscribed,
      permission,
      fcm: res.data.fcm ?? { configured: false },
      devices: res.data.devices ?? 0,
    };
  } catch {
    return { pushEnabled: false, subscribed: false, permission, fcm: { configured: false }, devices: 0 };
  }
}

/** Initialize (once) the Firebase app + messaging from server-provided config. */
async function getMessagingLazy(config: FcmClientConfig): Promise<import("firebase/messaging").Messaging | null> {
  const s = state();
  if (s.messaging) return s.messaging;
  if (!s.initPromise) {
    s.initPromise = (async () => {
      try {
        if (!("serviceWorker" in navigator) || typeof Notification === "undefined") return null;
        const { initializeApp, getApps } = await import("firebase/app");
        const { getMessaging } = await import("firebase/messaging");
        const app = getApps().find((a) => a.name === "hms-push") ?? initializeApp(config, "hms-push");
        return getMessaging(app);
      } catch (e) {
        console.error("fcm-client-init-failed", e);
        return null;
      }
    })();
  }
  const m = await s.initPromise;
  s.messaging = m;
  return m;
}

/**
 * Register this browser with Firebase and store the device on the backend.
 * MUST be called only after the user granted notification permission (the
 * permission UX lives in the UI layer — never prompt from here).
 */
export async function enableFcm(config: FcmClientConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    if (typeof Notification === "undefined") return { ok: false, error: "This browser does not support notifications." };
    if (!("serviceWorker" in navigator)) return { ok: false, error: "Service worker is not available." };

    const registration = await navigator.serviceWorker.ready;
    const messaging = await getMessagingLazy(config);
    if (!messaging) return { ok: false, error: "Firebase messaging is unavailable in this browser." };

    const { getToken } = await import("firebase/messaging");
    const token = await getToken(messaging, {
      vapidKey: config.vapidKey,
      serviceWorkerRegistration: registration, // the EXISTING /sw.js (spec §4)
    });
    if (!token) return { ok: false, error: "Could not obtain a Firebase device token." };

    // Firebase Installation ID — the current Firebase-recommended device identifier.
    let installationId = "";
    try {
      const { getInstallations, getId } = await import("firebase/installations");
      installationId = await getId(getInstallations());
    } catch { /* optional field */ }

    const { api } = await import("@/lib/hms/api-client");
    await api.post("/api/v1/push/devices/register", {
      token,
      installationId: installationId || undefined,
      platform: "WEB",
      deviceName: (navigator as unknown as { platform?: string }).platform || undefined,
      browser: /Edg\//.test(navigator.userAgent) ? "Edge" : /Chrome\//.test(navigator.userAgent) ? "Chrome" : /Firefox\//.test(navigator.userAgent) ? "Firefox" : /Safari\//.test(navigator.userAgent) ? "Safari" : undefined,
      operatingSystem: /Android/i.test(navigator.userAgent) ? "Android" : /iPhone|iPad|Macintosh/i.test(navigator.userAgent) ? (/(iPhone|iPad)/i.test(navigator.userAgent) ? "iOS" : "macOS") : /Windows/i.test(navigator.userAgent) ? "Windows" : /Linux/i.test(navigator.userAgent) ? "Linux" : undefined,
      permissionStatus: Notification.permission === "granted" ? "GRANTED" : "DENIED",
    });

    wireForeground(messaging);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not register this device." };
  }
}

/** Unregister this browser's FCM token locally + on the server. */
export async function disableFcm(): Promise<void> {
  try {
    const s = state();
    if (s.messaging) {
      try {
        const { deleteToken } = await import("firebase/messaging");
        await deleteToken(s.messaging);
      } catch { /* best-effort */ }
    }
    // Server-side unregister needs the token we had — read it again if the
    // messaging object survived; otherwise the stale device is cleaned by the
    // worker's invalid-destination handling.
    const { api } = await import("@/lib/hms/api-client");
    if (s.messaging) {
      const { getToken } = await import("firebase/messaging");
      const config = await currentClientConfig();
      const registration = await navigator.serviceWorker.ready;
      if (config) {
        const token = await getToken(s.messaging, { vapidKey: config.vapidKey, serviceWorkerRegistration: registration }).catch(() => "");
        if (token) {
          await api.post("/api/v1/push/devices/unregister", { token }).catch(() => undefined);
        }
      }
    }
    s.messaging = null;
    s.initPromise = null;
  } catch { /* best-effort */ }
}

async function currentClientConfig(): Promise<FcmClientConfig | null> {
  try {
    const st = await fetchExtendedPushStatus();
    return st.fcm.clientConfig ?? null;
  } catch {
    return null;
  }
}

/**
 * Foreground handling (spec §16): when the app is OPEN, do not double-notify.
 * The realtime provider already surfaces the in-app toast/badge for the same
 * business notification; this only fires a window event as a refresh fallback.
 */
function wireForeground(messaging: import("firebase/messaging").Messaging): void {
  const s = state();
  if (s.foregroundWired) return;
  s.foregroundWired = true;
  import("firebase/messaging")
    .then(({ onMessage }) => {
      onMessage(messaging, (payload) => {
        const data = (payload.data ?? {}) as { notificationId?: string; url?: string };
        window.dispatchEvent(new CustomEvent("hms:push-foreground", { detail: data }));
        if (document.visibilityState === "visible" && data.notificationId) {
          // Nudge the notifications UI to re-sync (harmless when realtime won).
          window.dispatchEvent(new Event("hms:notifications-refresh"));
        }
      });
    })
    .catch(() => undefined);
}

/**
 * Silent re-registration after login (spec §34): only when permission was
 * ALREADY granted — never prompts without context (spec §18). Fire-and-forget.
 */
export async function syncPushOnLogin(): Promise<void> {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const st = await fetchExtendedPushStatus();
    if (st.fcm.configured && st.fcm.clientConfig) {
      await enableFcm(st.fcm.clientConfig);
    }
    // Legacy VAPID browsers keep their subscription (no action needed).
  } catch { /* best-effort */ }
}
