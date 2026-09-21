// GET /api/v1/push/status — Push availability + this device's state.
// Auth required (any role). Public-by-design values only: the VAPID public key
// and the Firebase web client configuration are public identifiers; private
// keys / service accounts never leave the server (spec §25).

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { vapidPublicKey } from "@/lib/hms/push-server";
import { fcmClientConfig, fcmStatusSummary } from "@/lib/hms/push/fcm";

export const GET = handler(
  async ({ req, user }) => {
    const endpoint = req.nextUrl.searchParams.get("endpoint");
    let subscribed = false;
    if (endpoint) {
      const row = await db.pushSubscription.findUnique({
        where: { endpoint },
        select: { userId: true, revokedAt: true },
      });
      subscribed = !!row && row.userId === user.id && !row.revokedAt;
    }
    const enabled = !!vapidPublicKey();

    // FCM block: clientReady=false ⇒ browser falls back to legacy VAPID flow.
    const fcm = fcmStatusSummary();
    const clientConfig = fcmClientConfig();
    const deviceCount = await db.pushDevice.count({ where: { userId: user.id, active: true } });

    return ok({
      enabled,
      publicKey: enabled ? vapidPublicKey() : undefined,
      subscribed,
      fcm: {
        configured: fcm.configured && fcm.clientReady,
        projectId: fcm.clientReady ? fcm.projectId : undefined,
        clientConfig: clientConfig ?? undefined,
      },
      devices: deviceCount,
    });
  },
  { auth: true }
);
