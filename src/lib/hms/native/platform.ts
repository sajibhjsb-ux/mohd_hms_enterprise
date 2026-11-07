"use client";

// MOHD.HMS ENTERPRISE — native shell detection.
//
// The SAME web build runs in browsers and in the Capacitor WebView. Detection
// reads the bridge object Capacitor injects before the page scripts run, so no
// native package is pulled into the web bundle just to answer this question.
// All plugin calls are dynamically imported from the modules that need them.

export type NativePlatform = "android" | "ios";

type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

export function nativePlatform(): NativePlatform | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  if (!bridge) return null;
  if (bridge.isNativePlatform && !bridge.isNativePlatform()) return null;
  const platform = bridge.getPlatform?.();
  return platform === "android" || platform === "ios" ? platform : null;
}

export function isNativeApp(): boolean {
  return nativePlatform() !== null;
}
