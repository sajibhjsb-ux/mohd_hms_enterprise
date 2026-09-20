// GET    /api/v1/push/devices — list THIS user's registered push devices
//        (FCM devices + legacy VAPID subscriptions, merged; no tokens/secrets).
// DELETE /api/v1/push/devices?id=… — remove one of the user's OWN devices.
//        Idempotent and ownership-checked; a foreign id answers 200 without
//        leaking existence (spec §25).

import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";

export const GET = handler(
  async ({ user }) => {
    const [fcmDevices, vapid] = await Promise.all([
      db.pushDevice.findMany({
        where: { userId: user.id },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true, platform: true, deviceName: true, browser: true, operatingSystem: true,
          appVersion: true, permissionStatus: true, active: true, lastError: true,
          lastSeenAt: true, createdAt: true, updatedAt: true,
        },
      }),
      db.pushSubscription.findMany({
        where: { userId: user.id },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true, platform: true, deviceName: true, browser: true,
          lastSeenAt: true, createdAt: true, updatedAt: true, revokedAt: true,
        },
      }),
    ]);
    return ok({
      devices: fcmDevices.map((d) => ({
        id: d.id,
        kind: "FCM" as const,
        platform: d.platform,
        deviceName: d.deviceName,
        browser: d.browser,
        operatingSystem: d.operatingSystem,
        appVersion: d.appVersion,
        permissionStatus: d.permissionStatus,
        active: d.active,
        lastError: d.lastError,
        lastSeenAt: d.lastSeenAt,
        createdAt: d.createdAt,
      })),
      legacy: vapid.map((s) => ({
        id: s.id,
        kind: "VAPID" as const,
        platform: s.platform,
        deviceName: s.deviceName,
        browser: s.browser,
        operatingSystem: null,
        appVersion: null,
        permissionStatus: "GRANTED" as const,
        active: !s.revokedAt,
        lastError: "",
        lastSeenAt: s.lastSeenAt,
        createdAt: s.createdAt,
      })),
    });
  },
  { auth: true }
);

export const DELETE = handler(
  async ({ req, user }) => {
    const id = req.nextUrl.searchParams.get("id") ?? "";
    const kind = req.nextUrl.searchParams.get("kind") ?? "FCM";

    if (kind === "VAPID") {
      const row = await db.pushSubscription.findUnique({ where: { id }, select: { id: true, userId: true, revokedAt: true } });
      if (row && row.userId === user.id && !row.revokedAt) {
        await db.pushSubscription.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
        await audit({
          actorId: user.id, actorEmail: user.email,
          action: "PUSH_DEVICE_REMOVED", resourceType: "PUSH_SUBSCRIPTION", resourceId: row.id,
        });
      }
      return ok({ removed: true });
    }

    const row = await db.pushDevice.findUnique({ where: { id }, select: { id: true, userId: true, active: true } });
    if (row && row.userId === user.id && row.active) {
      await db.pushDevice.update({ where: { id: row.id }, data: { active: false, lastError: "Removed by user." } });
      await audit({
        actorId: user.id, actorEmail: user.email,
        action: "PUSH_DEVICE_REMOVED", resourceType: "PUSH_DEVICE", resourceId: row.id,
      });
    }
    // Idempotent: unknown/foreign ids answer 200 without leaking state.
    return ok({ removed: true });
  },
  { auth: true }
);
