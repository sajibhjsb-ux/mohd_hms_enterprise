// GET /api/v1/push/status — Web Push availability + this device's state.
// Auth required (any role). The VAPID public key is public by design;
// the private key never leaves the server. `endpoint` (optional query)
// scopes `subscribed` to the calling device.

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { vapidPublicKey } from "@/lib/hms/push-server";

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
    return ok({ enabled, publicKey: enabled ? vapidPublicKey() : undefined, subscribed });
  },
  { auth: true }
);
