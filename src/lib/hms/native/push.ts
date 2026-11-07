"use client";

// MOHD.HMS ENTERPRISE — native FCM registration (Capacitor Push Notifications).
//
// Reuses the EXISTING native push path end to end:
//   Capacitor registration token → POST /api/v1/push/devices/register
//   (platform ANDROID/IOS) → PushDevice row → the one push worker.
// Browser Web Push subscriptions remain a separate registration type. The
// native token is held in memory only; the stable installation id is random
// and non-secret.

import { isNativeApp, nativePlatform } from "./platform";

const INSTALL_KEY = "hms:nativeInstallationId";
const CHANNEL_ID = "facilitypro_default";

type ListenerHandle = { remove: () => Promise<void> | void };

const g = globalThis as unknown as {
  __hmsNativePush?: {
    started: boolean;
    userId: string | null;
    token: string | null;
    lastRegistered: string;
    listeners: ListenerHandle[];
    registering: Promise<{ ok: boolean; error?: string }> | null;
  };
};

function state() {
  g.__hmsNativePush ??= {
    started: false,
    userId: null,
    token: null,
    lastRegistered: "",
    listeners: [],
    registering: null,
  };
  return g.__hmsNativePush;
}

function installationId(): string {
  try {
    const existing = localStorage.getItem(INSTALL_KEY);
    if (existing) return existing;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(INSTALL_KEY, id);
    return id;
  } catch {
    return "";
  }
}

async function registerToken(token: string): Promise<{ ok: boolean; error?: string }> {
  const s = state();
  const userId = s.userId;
  if (!userId) return { ok: false, error: "Sign in again to receive notifications." };
  const marker = `${userId}:${token}`;
  if (s.lastRegistered === marker) return { ok: true };
  try {
    const { api } = await import("@/lib/hms/api-client");
    const { App } = await import("@capacitor/app");
    const info = await App.getInfo().catch(() => ({ name: "FacilityPro", version: "", build: "" }));
    const platform = nativePlatform();
    await api.post("/api/v1/push/devices/register", {
      token,
      installationId: installationId() || undefined,
      platform: platform === "ios" ? "IOS" : "ANDROID",
      deviceName: info.name?.slice(0, 100) || "FacilityPro mobile",
      browser: "FacilityPro Native",
      operatingSystem: platform === "ios" ? "iOS" : "Android",
      appVersion: [info.version, info.build].filter(Boolean).join("+").slice(0, 50) || undefined,
      permissionStatus: "GRANTED",
    });
    s.lastRegistered = marker;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not register this device." };
  }
}

async function startListeners(): Promise<void> {
  const s = state();
  if (s.started) return;
  s.started = true;
  const { PushNotifications } = await import("@capacitor/push-notifications");

  s.listeners.push(await PushNotifications.addListener("registration", (token) => {
    s.token = token.value;
    void registerToken(token.value);
  }));
  s.listeners.push(await PushNotifications.addListener("registrationError", (err) => {
    console.warn("native-push-registration-error", err.error);
  }));
  // Foreground messages are surfaced by the existing in-app notification UI.
  // No local notification is created here (presentationOptions: []), so one
  // event is never displayed twice by two handlers.
  s.listeners.push(await PushNotifications.addListener("pushNotificationReceived", (n) => {
    window.dispatchEvent(new CustomEvent("hms:push-foreground", { detail: n.data ?? {} }));
    if (n.data?.notificationId) window.dispatchEvent(new Event("hms:notifications-refresh"));
  }));

  try {
    await PushNotifications.createChannel({
      id: CHANNEL_ID,
      name: "FacilityPro alerts",
      description: "Complaints, work orders, inspections, finance and maintenance alerts.",
      importance: 4,
      visibility: 1,
      vibration: true,
    });
  } catch {
    // Android < 8 has no channels; nothing else changes.
  }
}

/**
 * Bind this installation to the signed-in user and obtain/refresh the FCM
 * token. Safe to call on every authenticated launch/resume — the backend
 * upserts by token and duplicate registrations are suppressed locally.
 */
export async function initNativePush(userId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isNativeApp() || !userId) return { ok: false, error: "Not a native session." };
  const s = state();
  s.userId = userId;
  if (s.registering) return s.registering;
  s.registering = (async () => {
    try {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      await startListeners();
      let permission = await PushNotifications.checkPermissions();
      if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") {
        permission = await PushNotifications.requestPermissions();
      }
      if (permission.receive !== "granted") {
        return { ok: false, error: "Notifications are off for this app. Enable them in your device settings." };
      }
      // Re-register whenever the user changes, even if the token is unchanged.
      s.lastRegistered = "";
      await PushNotifications.register();
      // Token arrives asynchronously through the registration listener.
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Could not enable notifications." };
    } finally {
      s.registering = null;
    }
  })();
  return s.registering;
}

/** Explicit "Enable notifications" action from Profile → Notifications. */
export async function enableNativePush(): Promise<{ ok: boolean; error?: string }> {
  const s = state();
  if (!s.userId) return { ok: false, error: "Sign in again to receive notifications." };
  if (s.registering) return s.registering;
  s.registering = (async () => {
    try {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      await startListeners();
      let permission = await PushNotifications.checkPermissions();
      if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") {
        permission = await PushNotifications.requestPermissions();
      }
      if (permission.receive !== "granted") {
        return { ok: false, error: "Notifications are off for this app. Enable them in your device settings." };
      }
      s.lastRegistered = "";
      if (s.token) return registerToken(s.token);
      await PushNotifications.register();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Could not enable notifications." };
    } finally {
      s.registering = null;
    }
  })();
  return s.registering;
}

/**
 * Stop this installation receiving the current user's notifications.
 * `server` removes the device row while the session is still valid; `plugin`
 * also deletes the FCM token (used on explicit disable / logout).
 */
export async function disableNativePush(opts: { server?: boolean; plugin?: boolean } = {}): Promise<void> {
  if (!isNativeApp()) return;
  const s = state();
  const token = s.token;
  if (opts.server !== false && token) {
    try {
      const { api } = await import("@/lib/hms/api-client");
      await api.post("/api/v1/push/devices/unregister", { token }).catch(() => undefined);
    } catch { /* best effort */ }
  }
  if (opts.plugin) {
    try {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      await PushNotifications.unregister();
      await PushNotifications.removeAllDeliveredNotifications();
    } catch { /* best effort */ }
    s.token = null;
    s.lastRegistered = "";
  }
  s.userId = null;
}
