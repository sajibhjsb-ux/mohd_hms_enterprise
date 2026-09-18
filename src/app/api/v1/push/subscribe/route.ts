// POST   /api/v1/push/subscribe — register this device for Web Push.
// DELETE /api/v1/push/subscribe?endpoint=… — revoke a device subscription.
// Auth required (any role); a user may register multiple devices. Device
// replacement is natural: the same endpoint upserts, an uninstalled browser's
// endpoint is revoked server-side when push delivery reports 404/410.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";
import { vapidPublicKey } from "@/lib/hms/push-server";

const subscribeSchema = z.object({
  endpoint: z.string().url("Invalid subscription endpoint.").refine(
    (v) => v.startsWith("https://") || v.startsWith("http://localhost"),
    "Subscription endpoint must be HTTPS."
  ),
  keys: z.object({
    p256dh: z.string().min(40).max(200),
    auth: z.string().min(16).max(64),
  }),
  deviceName: z.string().max(100).optional(),
  platform: z.string().max(50).optional(),
  browser: z.string().max(50).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    if (!vapidPublicKey()) throw Errors.badRequest("Push notifications are not configured on this server.");
    const ip = clientIp(req);
    const rl = rateLimit(`push-subscribe:${ip}:${user.id}`, 30, 5 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany(`Too many requests. Try again in ${rl.retryAfterSec}s.`);

    const body = await parseBody(req, subscribeSchema);

    const row = await db.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: {
        userId: user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        deviceName: body.deviceName ?? null,
        platform: body.platform ?? null,
        browser: body.browser ?? null,
        lastSeenAt: new Date(),
      },
      update: {
        // Re-subscribe after logout/uninstall: keep the CURRENT owner binding.
        userId: user.id,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        revokedAt: null,
        deviceName: body.deviceName ?? null,
        platform: body.platform ?? null,
        browser: body.browser ?? null,
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PUSH_SUBSCRIBED",
      resourceType: "PUSH_SUBSCRIPTION",
      resourceId: row.id,
      metadata: { platform: body.platform, browser: body.browser },
      ip,
    });
    return ok({ subscribed: true });
  },
  { auth: true }
);

export const DELETE = handler(
  async ({ req, user }) => {
    const endpoint = req.nextUrl.searchParams.get("endpoint");
    if (!endpoint) throw Errors.badRequest("endpoint is required.");

    const row = await db.pushSubscription.findUnique({ where: { endpoint }, select: { id: true, userId: true } });
    if (row && row.userId === user.id) {
      await db.pushSubscription.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "PUSH_UNSUBSCRIBED",
        resourceType: "PUSH_SUBSCRIPTION",
        resourceId: row.id,
      });
    }
    // Idempotent: unknown/foreign endpoints answer 200 without leaking state.
    return ok({ subscribed: false });
  },
  { auth: true }
);
