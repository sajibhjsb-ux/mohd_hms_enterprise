import type { CapacitorConfig } from "@capacitor/cli";

// MOHD.HMS ENTERPRISE / FacilityPro — Capacitor shell.
//
// The operational app (app.mohdhms.com) is a Next.js 16 App Router server
// application: auth, RBAC, MinIO uploads, FCM/VAPID delivery, QR verification
// and the realtime presence service all live on the server. A static export
// would delete those capabilities, so the native shell loads the SAME
// production origin inside the WebView and the existing web code activates
// its native bridge when it detects Capacitor.
//
// Override only for a verified staging origin, never for a dev server:
//   CAPACITOR_SERVER_URL=https://staging.example npx cap sync
const serverUrl = (process.env.CAPACITOR_SERVER_URL || "https://app.mohdhms.com").replace(/\/+$/, "");

const config: CapacitorConfig = {
  appId: "com.mohdhms.facilitypro",
  appName: "FacilityPro by MOHD.HMS ENTERPRISE",
  webDir: "mobile/www",
  // The web assets directory is only a branded first-run/error fallback; the
  // live application is served from the production origin above.
  server: {
    url: serverUrl,
    cleartext: false,
    androidScheme: "https",
    // Keep the app's own origin and the Google OAuth hop inside the WebView.
    // Notification deep links are validated and routed by src/lib/hms/native.
    allowNavigation: ["app.mohdhms.com", "accounts.google.com", "oauth2.googleapis.com"],
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#0c2414",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: false,
    },
    // Foreground pushes are surfaced by the existing in-app notification UI.
    // An empty list prevents a second OS notification for the same event.
    PushNotifications: {
      presentationOptions: [],
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0c2414",
      overlaysWebView: false,
    },
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: process.env.CAPACITOR_DEBUG === "1",
  },
  ios: {
    contentInset: "automatic",
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
