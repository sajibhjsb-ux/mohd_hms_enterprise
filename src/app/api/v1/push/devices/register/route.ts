// POST /api/v1/push/devices/register — register/refresh an FCM push device.
//
// Spec §7: the backend determines the authenticated user from the secure
// session context — a user_id sent by the browser is never trusted. The FCM
// registration token (provider-generated opaque identifier, not a secret)
// is the unique device key; re-registration upserts (token refresh path) so
// duplicates are impossible (spec §6/§9). Multi-device per user is expected.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";
import { audit } from "@/lib/hms/services";
import { fcmConfigured } from "@/lib/hms/push/fcm";

const registerSchema = z.object({
  token: z.string().min(40).max(4096),
  installationId: z.string().max(128).optional(),
  platform: z.enum(["WEB", "ANDROID", "IOS"]).default("WEB"),
  deviceName: z.string().max(100).optional(),
  browser: z.string().max(50).optional(),
  operatingSystem: z.string().max(50).optional(),
  appVersion: z.string().max(50).optional(),
  permissionStatus: z.enum(["GRANTED", "DENIED"]).default("GRANTED"),
});

export const POST = handler(
  async ({ req, user }) => {
    if (!fcmConfigured()) throw Errors.badRequest("Push notifications (Firebase) are not configured on this server.");
    const ip = clientIp(req);
    const rl = rateLimit(`push-device-register:${ip}:${user.id}`, 30, 5 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany(`Too many requests. Try again in ${rl.retryAfterSec}s.`);

    const body = await parseBody(req, registerSchema);

    // Re-bind protection (spec §34): a token already owned by ANOTHER user is
    // re-bound only via this authenticated upsert — the previous owner simply
    // loses the device row (FCM tokens are per browser-install, so a re-bind
    // means the same physical browser now belongs to the newly signed-in user).
    const row = await db.pushDevice.upsert({
      where: { token: body.token },
      create: {
        userId: user.id,
        token: body.token,
        installationId: body.installationId ?? "",
        platform: body.platform,
        deviceName: body.deviceName ?? null,
        browser: body.browser ?? null,
        operatingSystem: body.operatingSystem ?? null,
        appVersion: body.appVersion ?? null,
        permissionStatus: body.permissionStatus,
        active: true,
        lastSeenAt: new Date(),
      },
      update: {
        // Keep the CURRENT owner binding (fresh login wins).
        userId: user.id,
        installationId: body.installationId ?? "",
        platform: body.platform,
        deviceName: body.deviceName ?? null,
        browser: body.browser ?? null,
        operatingSystem: body.operatingSystem ?? null,
        appVersion: body.appVersion ?? null,
        permissionStatus: body.permissionStatus,
        active: body.permissionStatus === "GRANTED",
        failureCount: 0,
        lastError: "",
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "PUSH_DEVICE_REGISTERED",
      resourceType: "PUSH_DEVICE",
      resourceId: row.id,
      metadata: { platform: body.platform, browser: body.browser },
      ip,
    });
    return ok({ registered: true, deviceId: row.id });
  },
  { auth: true }
);
