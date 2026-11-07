// FCM message shape (pure) — split out so the native/web difference is
// testable without the server-only admin SDK.

export type FcmPayload = {
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

export type FcmMode = "web" | "native";

export type FcmWebMessage = {
  data: Record<string, string>;
  android: { priority: "normal" | "high"; ttl: number };
  webpush: { headers: Record<string, string>; fcmOptions: { link: string } };
};

export type FcmNativeMessage = {
  data: Record<string, string>;
  notification: { title: string; body: string };
  android: {
    priority: "normal" | "high";
    ttl: number;
    notification: { channelId: string; tag: string; sound: string; icon: string; color: string };
  };
  apns: {
    headers: Record<string, string>;
    payload: { aps: { alert: { title: string; body: string }; sound: string; "thread-id": string } };
  };
};

export function buildFcmMessage(payload: FcmPayload, mode: "native"): FcmNativeMessage;
export function buildFcmMessage(payload: FcmPayload, mode: "web"): FcmWebMessage;
export function buildFcmMessage(payload: FcmPayload, mode: FcmMode): FcmNativeMessage | FcmWebMessage {
  const data: Record<string, string> = {
    title: payload.title.slice(0, 120),
    body: payload.body.slice(0, 300),
    url: payload.route,
    tag: payload.tag.slice(0, 80),
    notificationId: payload.notificationId || "",
    type: payload.type || "",
    resourceType: payload.resourceType || "",
    resourceId: payload.resourceId || "",
    priority: payload.priority || "NORMAL",
  };
  const urgency = payload.priority === "NORMAL" ? "normal" : "high";
  const base = {
    data,
    android: { priority: urgency === "high" ? ("high" as const) : ("normal" as const), ttl: 3_600_000 },
  };
  if (mode === "native") {
    return {
      ...base,
      notification: { title: data.title, body: data.body },
      android: {
        ...base.android,
        notification: {
          channelId: "facilitypro_default",
          tag: data.tag,
          sound: "default",
          icon: "ic_stat_notification",
          color: "#0c2414",
        },
      },
      apns: {
        headers: { "apns-priority": "10" },
        payload: {
          aps: {
            alert: { title: data.title, body: data.body },
            sound: "default",
            "thread-id": data.tag,
          },
        },
      },
    };
  }
  return {
    ...base,
    webpush: {
      headers: { Urgency: urgency, "TTL": "3600" },
      fcmOptions: { link: payload.route },
    },
  };
}
