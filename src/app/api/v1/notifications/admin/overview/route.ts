// MOHD.HMS ENTERPRISE — Notification Gateway admin overview.
//
// Single aggregated health/summary endpoint for the centralized Notification
// Gateway (§43): channel config + transport health (email SMTP/Resend,
// WhatsApp gateway, FCM/VAPID push, realtime service), queue depths and recent
// delivery failures. Gated behind settings.read / push.manage — never exposes
// secrets (only configured boolean + masked hints from existing safe config
// builders).

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { emailHealth } from "@/lib/hms/email/service";
import { getWhatsAppConfig, toSafeConfig } from "@/lib/hms/whatsapp/config";
import { fcmStatusSummary } from "@/lib/hms/push/fcm";
import { dispatcherHealth } from "@/lib/hms/realtime/dispatcher";

const SERVICE_URL = process.env.REALTIME_INTERNAL_URL ?? "http://127.0.0.1:3004";
const SECRET = process.env.REALTIME_INTERNAL_SECRET ?? "hms-realtime-internal-secret-v1";

export const GET = handler(
  async ({ user }) => {
    // settings.read gate enforced by the handler; only super admins / admins
    // reach here in practice (mirrors /api/v1/realtime/health).
    void user;

    const [email, whatsappCfg, fcm, realtime, pushAgg, counts, recentErrors, pendingEvents] = await Promise.all([
      emailHealth(),
      getWhatsAppConfig(),
      fcmStatusSummary(),
      fetch(`${SERVICE_URL}/internal/health`, {
        headers: { "x-realtime-secret": SECRET },
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { ok: boolean; data?: unknown } | null) => (j?.ok ? j.data : null))
        .catch(() => null),
      db.pushLog.groupBy({ by: ["status"], _count: { _all: true } }),
      Promise.all([
        db.notification.count(),
        db.notification.count({ where: { readAt: null } }),
        db.notification.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } } }),
      ]),
      db.pushLog.findMany({
        where: { status: { in: ["FAILED", "DEAD_LETTER"] }, errorCode: { not: "" } },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true, status: true, channel: true, errorCode: true, lastError: true, title: true, updatedAt: true },
      }),
      db.domainEvent.count({ where: { status: "PENDING" } }),
    ]);

    const pushByStatus = Object.fromEntries((pushAgg ?? []).map((g) => [g.status, g._count._all]));

    const wc = toSafeConfig(whatsappCfg);
    const whatsapp = {
      configured: wc.hasApiKey && !!wc.gatewayBaseUrl && wc.enabled,
      enabled: wc.enabled,
      session: wc.sessionStatus,
      lastConnectedAt: wc.lastConnectedAt,
      lastOutboundAt: wc.lastOutboundAt,
      lastError: wc.sessionError || null,
    };

    return ok({
      channels: {
        email: { configured: email.smtp.configured, provider: email.smtp.provider, lastVerified: email.smtp.lastVerifyOk },
        whatsapp,
        push: { fcm: fcm.configured, vapidConfigured: true, clientReady: fcm.clientReady },
        realtime: { online: Boolean(realtime), clients: (realtime as { connectedClients?: number } | null)?.connectedClients ?? 0 },
      },
      queue: {
        notifications: { total: counts[0], unread: counts[1], last24h: counts[2] },
        push: pushByStatus,
        email: { queued: email.queued, retrying: email.retrying },
        realtimeOutbox: pendingEvents,
      },
      recentErrors,
      dispatcher: dispatcherHealth(),
    });
  },
  { permission: PERMISSIONS.settings_read }
);