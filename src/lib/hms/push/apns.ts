import "server-only";

// Apple Push Notification service (APNs) transport for native iOS builds.
//
// Capacitor's push plugin returns the APNs device token on iOS (not an FCM
// token), so iOS can never be routed through sendFcmToTokens. This transport
// speaks Apple's HTTP/2 API directly with the team's .p8 auth key.
//
// Configuration (all required; the transport is inactive until complete):
//   APNS_KEY_P8      inline .p8 contents, OR APNS_KEY_PATH to the file
//   APNS_KEY_ID      Key ID from the Apple Developer portal
//   APNS_TEAM_ID     Apple Developer team ID
//   APNS_TOPIC       bundle id (default com.mohdhms.facilitypro)
//   APNS_ENV         "production" (default) or "sandbox" for debug builds
//
// No secret is ever logged. The provider JWT is cached in memory for <60 min.

import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { signProviderJwt } from "./apns-jwt";

export type ApnsPayload = {
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

export type ApnsOutcome =
  | { token: string; kind: "sent"; messageId: string }
  | { token: string; kind: "permanent"; error: string }
  | { token: string; kind: "transient"; error: string };

type ApnsConfig = {
  key: string;
  keyId: string;
  teamId: string;
  topic: string;
  env: "production" | "sandbox";
};

const g = globalThis as unknown as {
  __hmsApns?: { config: ApnsConfig | null; jwt: string; jwtAt: number };
};

function state() {
  g.__hmsApns ??= { config: null, jwt: "", jwtAt: 0 };
  return g.__hmsApns;
}

function readConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  if (!keyId || !teamId) return null;
  let key = process.env.APNS_KEY_P8?.replace(/\\n/g, "\n").trim() ?? "";
  const path = process.env.APNS_KEY_PATH?.trim();
  if (!key && path) {
    try {
      key = readFileSync(path, "utf8");
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "PUSH", msg: "apns-key-unreadable", err: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }
  if (!key.includes("BEGIN PRIVATE KEY")) return null;
  return {
    key,
    keyId,
    teamId,
    topic: process.env.APNS_TOPIC?.trim() || "com.mohdhms.facilitypro",
    env: process.env.APNS_ENV?.trim() === "sandbox" ? "sandbox" : "production",
  };
}

export function apnsConfigured(): boolean {
  const s = state();
  if (!s.config) s.config = readConfig();
  return s.config !== null;
}

function providerToken(cfg: ApnsConfig): string {
  const s = state();
  // Apple rejects tokens older than 1 hour; refresh after 50 minutes.
  if (s.jwt && Date.now() - s.jwtAt < 50 * 60 * 1000) return s.jwt;
  s.jwt = signProviderJwt(cfg);
  s.jwtAt = Date.now();
  return s.jwt;
}

function body(payload: ApnsPayload): string {
  return JSON.stringify({
    aps: {
      alert: { title: payload.title.slice(0, 120), body: payload.body.slice(0, 300) },
      sound: "default",
      "thread-id": payload.tag.slice(0, 80),
    },
    url: payload.route,
    tag: payload.tag.slice(0, 80),
    notificationId: payload.notificationId || "",
    type: payload.type || "",
    resourceType: payload.resourceType || "",
    resourceId: payload.resourceId || "",
    priority: payload.priority || "NORMAL",
  });
}

function permanentReason(status: number, reason: string): boolean {
  if (status === 410) return true;
  return ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "BadCollapseId"].includes(reason);
}

export async function sendApnsToTokens(tokens: string[], payload: ApnsPayload): Promise<ApnsOutcome[]> {
  if (tokens.length === 0) return [];
  const s = state();
  if (!s.config) s.config = readConfig();
  if (!s.config) return tokens.map((token) => ({ token, kind: "transient" as const, error: "APNS_NOT_CONFIGURED" }));

  const cfg = s.config;
  const host = cfg.env === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const jwt = providerToken(cfg);
  const json = body(payload);
  const client = http2.connect(host);
  // A failed connection must surface per-request, never as an unhandled crash.
  client.on("error", () => undefined);
  const outcomes: ApnsOutcome[] = [];

  try {
    await Promise.all(tokens.map(async (token) => {
      try {
        const result = await new Promise<{ status: number; body: string; id: string }>((resolve, reject) => {
          const req = client.request({
            ":method": "POST",
            ":path": `/3/device/${encodeURIComponent(token)}`,
            authorization: `bearer ${jwt}`,
            "apns-topic": cfg.topic,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
            "content-type": "application/json",
          });
          let status = 0;
          let text = "";
          let apnsId = "";
          req.on("response", (headers) => {
            status = Number(headers[":status"] ?? 0);
            apnsId = String(headers["apns-id"] ?? "");
          });
          req.setEncoding("utf8");
          req.on("data", (chunk) => { text += chunk; });
          req.setTimeout(10_000, () => req.destroy(new Error("APNS_TIMEOUT")));
          req.on("error", reject);
          req.on("end", () => resolve({ status, body: text, id: apnsId }));
          req.end(json);
        });
        if (result.status === 200) {
          outcomes.push({ token, kind: "sent", messageId: result.id });
          return;
        }
        let reason = "";
        try { reason = String((JSON.parse(result.body) as { reason?: string }).reason ?? ""); } catch { /* empty */ }
        const detail = `APNS_${result.status}${reason ? `: ${reason}` : ""}`.slice(0, 200);
        outcomes.push({ token, kind: permanentReason(result.status, reason) ? "permanent" : "transient", error: detail });
      } catch (e) {
        outcomes.push({ token, kind: "transient", error: `APNS_SEND_FAILED: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
      }
    }));
  } finally {
    client.close();
  }
  return outcomes;
}

export function apnsStatusSummary(): { configured: boolean; environment: "production" | "sandbox" | null; topic: string | null } {
  const s = state();
  if (!s.config) s.config = readConfig();
  return { configured: s.config !== null, environment: s.config?.env ?? null, topic: s.config?.topic ?? null };
}
