import "server-only";

// MOHD.HMS ENTERPRISE — Firebase Cloud Messaging (FCM) transport (server half).
//
// The ONE FCM integration point for the existing push pipeline
// (lib/hms/push-server.ts → push/worker.ts). Modules never talk to Firebase
// directly — the NotificationService decides recipients, this file only knows
// how to deliver to FCM registration tokens.
//
// Credential handling (spec §25/§38):
//   • The service-account private key lives ONLY in server env — never in the
//     database, never in code, never shipped to the browser.
//   • Only PUBLIC Firebase web client configuration is exposed
//     (fcmClientConfig() → served to authenticated clients via
//     /api/v1/push/status; these values are public identifiers by design).
//
// Configuration (all optional — the transport is inactive until configured):
//   FIREBASE_SERVICE_ACCOUNT          inline service-account JSON, OR
//   FIREBASE_SERVICE_ACCOUNT_PATH     path to the JSON file, OR
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY  trio
//   FIREBASE_VAPID_KEY                web push certificate PUBLIC key (required
//                                     for web getToken; public by design)
//   FIREBASE_CLIENT_API_KEY / _AUTH_DOMAIN / _STORAGE_BUCKET /
//   FIREBASE_CLIENT_MESSAGING_SENDER_ID / _APP_ID / _MEASUREMENT_ID
//
// The Admin SDK is imported lazily: an unconfigured deployment never pays the
// module-load cost, and a missing/invalid credential NEVER breaks a business
// request — pushes degrade to SKIPPED with an explicit error code instead.

// ───────────────────────────── configuration ────────────────────────────────

export type FcmServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

function readServiceAccount(): FcmServiceAccount | null {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  let raw: string | null = null;
  if (inline) {
    raw = inline;
  } else if (path) {
    try {
      // Node/Bun fs is available in the Next.js server runtime.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      raw = require("fs").readFileSync(path, "utf8") as string;
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "PUSH", msg: "fcm-service-account-unreadable", err: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }
  if (!raw) {
    // Explicit trio fallback (secret managers often split the fields).
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
    if (projectId && clientEmail && privateKey) {
      return { projectId, clientEmail, privateKey };
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
    if (parsed.project_id && parsed.client_email && parsed.private_key) {
      return {
        projectId: process.env.FIREBASE_PROJECT_ID?.trim() || parsed.project_id,
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key.replace(/\\n/g, "\n"),
      };
    }
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "PUSH", msg: "fcm-service-account-incomplete" }));
    return null;
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "PUSH", msg: "fcm-service-account-parse-failed", err: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

/** Public Firebase web client configuration (safe to serve to browsers). */
export type FcmClientConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
  /** Web Push certificate public key — required by getToken(); public by design. */
  vapidKey: string;
};

const g = globalThis as unknown as {
  __hmsFcm?: {
    account: FcmServiceAccount | null;
    appPromise: Promise<{ messaging: FcmMessagingLike } | null> | null;
  };
};

function fcmState() {
  g.__hmsFcm ??= { account: null, appPromise: null };
  if (g.__hmsFcm.account === null) g.__hmsFcm.account = readServiceAccount();
  return g.__hmsFcm;
}

/** Minimal structural type — avoids importing firebase-admin at module load. */
type FcmMessagingLike = {
  sendEachForMulticast: (
    message: {
      tokens: string[];
      data?: Record<string, string>;
      webpush?: {
        headers?: Record<string, string>;
        fcmOptions?: { link?: string };
      };
      android?: { priority?: "default" | "normal" | "high"; ttl?: number };
    },
  ) => Promise<{
    successCount: number;
    failureCount: number;
    responses: Array<{ success: boolean; messageId?: string; error?: { code?: string; message?: string } }>;
  }>;
};

/** True when a syntactically valid service account is present in the env. */
export function fcmConfigured(): boolean {
  return fcmState().account !== null;
}

export function fcmProjectId(): string | null {
  return fcmState().account?.projectId ?? null;
}

/**
 * Public client configuration for the browser Firebase Messaging SDK.
 * Returns null when Firebase or the web-push certificate is not configured —
 * the client then falls back to the legacy VAPID web-push transport.
 */
export function fcmClientConfig(): FcmClientConfig | null {
  if (!fcmConfigured()) return null;
  const projectId = fcmProjectId() ?? "";
  const apiKey = process.env.FIREBASE_CLIENT_API_KEY?.trim() ?? "";
  const appId = process.env.FIREBASE_CLIENT_APP_ID?.trim() ?? "";
  const senderId = process.env.FIREBASE_CLIENT_MESSAGING_SENDER_ID?.trim() ?? "";
  const vapidKey = process.env.FIREBASE_VAPID_KEY?.trim() ?? "";
  // All five are required for a working web client; partial configuration is
  // reported as unconfigured (honest status) rather than failing at send time.
  if (!apiKey || !appId || !senderId || !vapidKey || !projectId) return null;
  return {
    apiKey,
    authDomain: process.env.FIREBASE_CLIENT_AUTH_DOMAIN?.trim() || `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: process.env.FIREBASE_CLIENT_STORAGE_BUCKET?.trim() || `${projectId}.appspot.com`,
    messagingSenderId: senderId,
    appId,
    measurementId: process.env.FIREBASE_CLIENT_MEASUREMENT_ID?.trim() || undefined,
    vapidKey,
  };
}

async function getMessaging(): Promise<FcmMessagingLike | null> {
  const state = fcmState();
  if (!state.account) return null;
  if (!state.appPromise) {
    state.appPromise = (async () => {
      try {
        const admin = await import("firebase-admin");
        const { getApps, initializeApp, cert } = admin;
        const account = state.account!;
        const app =
          getApps().find((a) => a.name === "hms-push") ??
          initializeApp(
            { credential: cert({ projectId: account.projectId, clientEmail: account.clientEmail, privateKey: account.privateKey }) },
            "hms-push"
          );
        console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", channel: "PUSH", msg: "fcm-admin-initialized", projectId: account.projectId }));
        // getMessaging returns the full SDK type; structurally compatible here.
        return { messaging: admin.getMessaging(app) as unknown as FcmMessagingLike };
      } catch (e) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "PUSH", msg: "fcm-admin-init-failed", err: e instanceof Error ? e.message : String(e) }));
        return null;
      }
    })();
  }
  const app = await state.appPromise;
  return app?.messaging ?? null;
}

// ─────────────────────────────── delivery ───────────────────────────────────

/** FCM request limit: 500 registration tokens per multicast send. */
const MULTICAST_CHUNK = 500;

export type FcmOutcome =
  | { token: string; kind: "sent"; messageId: string }
  | { token: string; kind: "permanent"; error: string }
  | { token: string; kind: "transient"; error: string };

const PERMANENT_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/mismatched-sender-id",
  "messaging/invalid-recipient",
]);

function classifyTokenError(err: { code?: string; message?: string }): "permanent" | "transient" {
  const code = err.code ?? "";
  if (PERMANENT_CODES.has(code)) return "permanent";
  // Unknown/undocumented errors are treated as transient so a malformed token
  // is retried (and pruned by the failure counter) instead of silently dropped.
  return "transient";
}

export type FcmPayload = {
  /** Data-only message: the existing /sw.js push handler displays + routes it. */
  title: string;
  body: string;
  route: string;
  tag: string;
  priority: "NORMAL" | "HIGH" | "CRITICAL";
  notificationId: string;
  type: string;
  resourceType: string;
  resourceId: string;
};

/**
 * Send ONE logical message to N tokens. Per-recipient results (spec §22) — a
 * batch is never treated as all-or-nothing. Returns per-token outcomes.
 */
export async function sendFcmToTokens(tokens: string[], payload: FcmPayload): Promise<FcmOutcome[]> {
  if (tokens.length === 0) return [];
  const messaging = await getMessaging();
  if (!messaging) {
    return tokens.map((token) => ({ token, kind: "transient" as const, error: "FCM_NOT_INITIALIZED" }));
  }

  // Data-only messages keep the existing service worker in charge of display
  // and click routing (ONE service worker — no competing firebase-messaging-sw).
  const data: Record<string, string> = {
    title: payload.title.slice(0, 120),
    body: payload.body.slice(0, 300),
    url: payload.route,
    tag: payload.tag.slice(0, 80),
    notificationId: payload.notificationId,
    type: payload.type,
    resourceType: payload.resourceType,
    resourceId: payload.resourceId,
    priority: payload.priority,
  };
  const urgency = payload.priority === "NORMAL" ? "normal" : "high";
  const message = {
    data,
    webpush: {
      headers: { Urgency: urgency, "TTL": "3600" },
      fcmOptions: { link: payload.route },
    },
    android: { priority: urgency === "high" ? ("high" as const) : ("normal" as const), ttl: 3_600_000 },
  };

  const outcomes: FcmOutcome[] = [];
  for (let i = 0; i < tokens.length; i += MULTICAST_CHUNK) {
    const chunk = tokens.slice(i, i + MULTICAST_CHUNK);
    try {
      const res = await messaging.sendEachForMulticast({ ...message, tokens: chunk });
      chunk.forEach((token, idx) => {
        const r = res.responses[idx];
        if (r?.success && r.messageId) outcomes.push({ token, kind: "sent", messageId: r.messageId });
        else if (r?.error) {
          const kind = classifyTokenError(r.error);
          outcomes.push({ token, kind, error: `${r.error.code ?? "fcm-error"}: ${r.error.message ?? ""}`.slice(0, 200) });
        } else outcomes.push({ token, kind: "transient", error: "FCM_EMPTY_RESPONSE" });
      });
    } catch (e) {
      // Whole-chunk failure (auth/network/quota) — transient for this chunk.
      const err = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "PUSH", msg: "fcm-send-failed", err: err.slice(0, 200), chunkSize: chunk.length }));
      for (const token of chunk) outcomes.push({ token, kind: "transient", error: `FCM_BATCH_FAILED: ${err.slice(0, 120)}` });
    }
  }
  return outcomes;
}

/** Public facts for admin visibility — never includes credentials. */
export function fcmStatusSummary(): { configured: boolean; projectId: string | null; clientReady: boolean } {
  return {
    configured: fcmConfigured(),
    projectId: fcmProjectId(),
    clientReady: fcmClientConfig() !== null,
  };
}
