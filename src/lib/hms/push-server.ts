import "server-only";

// MOHD.HMS ENTERPRISE — Web Push delivery (server half).
// Integrates with the existing NotificationService: every in-app notification
// may also be delivered as a Web Push to the recipient's registered devices.
// RBAC is inherent — recipients are the exact users the business event
// targets (notify()/notifyRole()), never a broadcast.
//
// VAPID private keys live ONLY in server env (never bundled/shipped).

import webpush from "web-push";
import { db } from "@/lib/db";

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
const SUBJECT = process.env.VAPID_SUBJECT?.trim() || "mailto:it@mohdhms.com";

let configured = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
  } catch (e) {
    console.error("push-config-failed", e);
  }
}

export function vapidPublicKey(): string | null {
  return configured ? PUBLIC_KEY : null;
}

/** Existing resource → dedicated application route (mirrors RESOURCE_ROUTES). */
function routeFor(resourceType?: string, resourceId?: string): string {
  if (!resourceType || !resourceId) return "/dashboard";
  switch (resourceType) {
    case "COMPLAINT": return `/complaints/${resourceId}`;
    case "WORK_ORDER": return `/work-orders/${resourceId}`;
    case "EQUIPMENT": return `/equipment/${resourceId}`;
    case "CUSTOMER": return `/customers/${resourceId}`;
    case "INVOICE": return `/invoices/${resourceId}`;
    case "QUOTATION": return `/quotations/${resourceId}`;
    case "PURCHASE_ORDER": return `/purchases/${resourceId}`;
    case "INVENTORY_ITEM": return `/inventory/${resourceId}`;
    case "INSPECTION_REPORT": return `/irms/reports/${resourceId}`;
    default: return "/dashboard";
  }
}

export type PushPayload = {
  title: string;
  body: string;
  resourceType?: string;
  resourceId?: string;
};

/**
 * Deliver a push to every active device of one user. Best-effort and
 * failure-tolerant by design — a push outage must never break a business
 * action. Expired endpoints (404/410) are marked revoked for pruning.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!configured) return;
  try {
    const subs = await db.pushSubscription.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subs.length === 0) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: routeFor(payload.resourceType, payload.resourceId),
      tag: payload.resourceId ? `${payload.resourceType}:${payload.resourceId}` : undefined,
    });

    await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            { TTL: 3600 }
          );
          await db.pushSubscription.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // Subscription expired/uninstalled — revoke; client re-subscribes on next enable.
            await db.pushSubscription.update({ where: { id: s.id }, data: { revokedAt: new Date() } }).catch(() => undefined);
          } else if (status && status >= 400) {
            console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", channel: "PUSH", status, endpoint: s.endpoint.slice(0, 60) }));
          }
        }
      })
    );
  } catch (e) {
    console.error("push-send-failed", e);
  }
}
