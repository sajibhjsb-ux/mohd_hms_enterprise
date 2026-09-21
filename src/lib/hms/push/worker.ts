import "server-only";

// MOHD.HMS ENTERPRISE — Push delivery worker (the ONE push delivery loop).
// Mirrors the established EmailService/WhatsAppService worker pattern:
//   QUEUED → SENDING → SENT / FAILED (retry with backoff) → DEAD_LETTER
//   SKIPPED when no transport is configured (honest state — never fake SENT).
// Driven by the existing scheduler (workflows/scheduler.ts — no second
// scheduler) and kicked directly after enqueue for low latency.
//
// Failure policy (spec §22):
//   • transient FCM/network errors → retry with exponential backoff
//     (30s → 2m → 10m), max 3 attempts, then DEAD_LETTER.
//   • permanent per-token errors (unregistered/invalid) → deactivate the
//     device immediately (never retried forever).
//   • a send result is evaluated PER RECIPIENT, never all-or-nothing.
//
// Nothing here ever blocks or fails a business transaction: enqueue is
// fire-and-forget from the NotificationService, and every worker step is
// try/catch guarded. Structured logs carry NO tokens or credentials.

import { db } from "@/lib/db";
import { isAutomationEnabled } from "@/lib/hms/workflows/settings";
import { ensureVapidConfigured } from "./vapid";
import { sendFcmToTokens, fcmConfigured } from "./fcm";

const CLAIM_BATCH = 25;
const STUCK_SENDING_MS = 5 * 60 * 1000;
const MAX_FAILURES_BEFORE_PRUNE = 5;
const PUSH_LOG_RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Backoff for attempt N (1-based): 30s, 2m, 10m. */
function backoffMs(attempt: number): number {
  if (attempt <= 1) return 30_000;
  if (attempt === 2) return 120_000;
  return 600_000;
}

const g = globalThis as unknown as { __hmsPushWorkerBusy?: boolean; __hmsPushCleanupAt?: number };

/** Fire-and-forget worker kick (never blocks the enqueuing request — §105). */
export function kickPushWorker(): void {
  if (typeof setImmediate !== "function") return;
  setImmediate(() => {
    import("./worker")
      .then((m) => m.tickPushWorker())
      .catch((e) => console.error("push-kick-failed", e));
  });
}

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, channel: "PUSH", msg, ...extra }));
}

/** Reset rows stuck in SENDING (e.g. process crash mid-send) back to QUEUED. */
async function recoverStuck(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_SENDING_MS);
  const res = await db.pushLog.updateMany({
    where: { status: "SENDING", updatedAt: { lt: cutoff } },
    data: { status: "QUEUED" },
  });
  if (res.count > 0) log("warn", "push-stuck-sending-recovered", { count: res.count });
}

/**
 * Process a single PushLog row end-to-end. The row is claimed with an
 * optimistic updateMany (status QUEUED → SENDING) so concurrent scheduler
 * ticks and direct kicks can never double-send one row.
 */
async function processOne(logId: string): Promise<void> {
  const claimed = await db.pushLog.updateMany({ where: { id: logId, status: "QUEUED" }, data: { status: "SENDING" } });
  if (claimed.count === 0) return; // another tick took it

  const row = await db.pushLog.findUnique({ where: { id: logId } });
  if (!row) return;

  // Fan-out targets: FCM devices + legacy VAPID subscriptions. A user may have
  // either, both, or none; every transport is attempted (dedupe by unique keys
  // makes double registration impossible — one row per token / endpoint).
  // Admin test sends may target ONE device (spec §31).
  const deviceFilter = row.targetDeviceId ? { id: row.targetDeviceId } : {};
  const [devices, subs] = await Promise.all([
    db.pushDevice.findMany({
      where: { userId: row.userId, active: true, permissionStatus: { not: "DENIED" }, ...deviceFilter },
      select: { id: true, token: true },
    }),
    db.pushSubscription.findMany({
      where: { userId: row.userId, revokedAt: null, ...(row.targetDeviceId ? { id: row.targetDeviceId } : {}) },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    }),
  ]);

  const deviceCount = devices.length + subs.length;
  let sentCount = 0;
  let failedPermanent = 0;
  let failedTransient = 0;
  let skippedCount = 0;
  let firstMessageId = "";
  let firstError = "";
  let errorCode = "";

  const fcmReady = fcmConfigured() && (await isAutomationEnabled("push_notifications"));
  // Configure THIS module instance of web-push (see vapid.ts — the scheduler
  // bundle loads its own copy; without this the send lacks the VAPID auth
  // header and the push service answers 401).
  const vapidReady = ensureVapidConfigured();

  // ── FCM transport ──
  if (devices.length > 0) {
    if (!fcmReady) {
      skippedCount += devices.length;
      errorCode = errorCode || "Unconfigured";
      firstError = firstError || (fcmConfigured() ? "FCM channel is disabled (Settings → Automation → Push notifications)." : "Firebase is not configured on this server.");
    } else {
      const outcomes = await sendFcmToTokens(devices.map((d) => d.token), {
        title: row.title,
        body: row.body,
        route: row.route,
        tag: row.resourceId ? `${row.resourceType}:${row.resourceId}` : row.notificationId || row.id,
        priority: (row.priority === "HIGH" || row.priority === "CRITICAL" ? row.priority : "NORMAL") as "NORMAL" | "HIGH" | "CRITICAL",
        notificationId: row.notificationId,
        type: row.type,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
      });
      for (const o of outcomes) {
        const device = devices.find((d) => d.token === o.token);
        if (!device) continue;
        if (o.kind === "sent") {
          sentCount += 1;
          if (!firstMessageId) firstMessageId = o.messageId;
          await db.pushDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), failureCount: 0, lastError: "" } }).catch(() => undefined);
        } else if (o.kind === "permanent") {
          failedPermanent += 1;
          if (!firstError) firstError = o.error;
          errorCode = errorCode || "Permanent";
          // Invalid/unregistered installation → deactivate; the client
          // re-registers a fresh token on next enable (spec §22/§29).
          await db.pushDevice.update({
            where: { id: device.id },
            data: { active: false, lastError: o.error.slice(0, 180), failureCount: { increment: 1 } },
          }).catch(() => undefined);
        } else {
          failedTransient += 1;
          if (!firstError) firstError = o.error;
          errorCode = errorCode || "Transient";
          await db.pushDevice.update({
            where: { id: device.id },
            data: { lastError: o.error.slice(0, 180), failureCount: { increment: 1 } },
          }).catch(() => undefined);
        }
      }
    }
  }

  // ── Legacy VAPID web-push transport (existing behavior preserved) ──
  if (subs.length > 0) {
    if (!vapidReady) {
      skippedCount += subs.length;
      errorCode = errorCode || "Unconfigured";
      firstError = firstError || "VAPID is not configured on this server.";
    } else {
      const webpush = (await import("web-push")).default;
      const body = JSON.stringify({
        title: row.title,
        body: row.body,
        url: row.route,
        tag: row.resourceId ? `${row.resourceType}:${row.resourceId}` : undefined,
        notificationId: row.notificationId,
        type: row.type,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        priority: row.priority,
      });
      const results = await Promise.allSettled(
        subs.map(async (s) => {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600 });
            await db.pushSubscription.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
            return "sent" as const;
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await db.pushSubscription.update({ where: { id: s.id }, data: { revokedAt: new Date() } }).catch(() => undefined);
              return "permanent" as const;
            }
            // Observability (§37): keep the real failure reason for the log —
            // never tokens or credentials, just the transport error.
            const detail = `${status ?? ""} ${err instanceof Error ? err.message : String(err)}`.trim().slice(0, 160);
            log("warn", "push-vapid-delivery-failed", { err: detail });
            if (!firstError || firstError === "VAPID delivery failed.") firstError = detail || "VAPID delivery failed.";
            return "transient" as const;
          }
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          if (r.value === "sent") sentCount += 1;
          else if (r.value === "permanent") { failedPermanent += 1; errorCode = errorCode || "Permanent"; if (!firstError) firstError = "VAPID subscription expired (404/410)."; }
          else { failedTransient += 1; errorCode = errorCode || "Transient"; if (!firstError) firstError = "VAPID delivery failed."; }
        } else {
          failedTransient += 1;
          errorCode = errorCode || "Transient";
          if (!firstError) firstError = "VAPID delivery threw.";
        }
      }
    }
  }

  if (deviceCount === 0) {
    // No eligible devices: nothing to attempt — mark honestly, no retry loop.
    await db.pushLog.update({
      where: { id: row.id },
      data: {
        status: "SKIPPED", deviceCount: 0, skippedCount: 0,
        errorCode: "NoDevices", lastError: "No active push devices for this user.",
        attemptCount: { increment: 1 }, channel: fcmReady ? "FCM" : "VAPID",
      },
    });
    return;
  }

  const attempt = row.attemptCount + 1;
  const anySent = sentCount > 0;
  const allAccounted = sentCount + failedPermanent + failedTransient + skippedCount === deviceCount;
  const retryable = failedTransient > 0 && !anySent && allAccounted;

  if (anySent || !retryable) {
    // Terminal: delivered to at least one device, OR nothing retryable remains.
    await db.pushLog.update({
      where: { id: row.id },
      data: {
        status: anySent ? "SENT" : failedPermanent > 0 ? "FAILED" : "SKIPPED",
        deviceCount, sentCount, failedCount: failedPermanent + failedTransient, skippedCount,
        attemptCount: attempt,
        sentAt: anySent ? new Date() : null,
        errorCode: anySent ? "" : errorCode,
        lastError: anySent ? "" : firstError,
        fcmMessageId: firstMessageId,
        channel: fcmReady ? "FCM" : "VAPID",
      },
    });
    log(anySent ? "info" : "warn", anySent ? "push-sent" : "push-terminal-failure", {
      pushLogId: row.id, userId: row.userId, sent: sentCount, failed: failedPermanent + failedTransient, skipped: skippedCount,
      err: anySent ? "" : firstError.slice(0, 120),
    });
    return;
  }

  if (retryable && attempt < row.maxAttempts) {
    await db.pushLog.update({
      where: { id: row.id },
      data: {
        status: "QUEUED", deviceCount, sentCount, failedCount: failedPermanent + failedTransient, skippedCount,
        attemptCount: attempt, scheduledAt: new Date(Date.now() + backoffMs(attempt)),
        errorCode: errorCode || "Transient", lastError: firstError, channel: fcmReady ? "FCM" : "VAPID",
      },
    });
    log("warn", "push-retry-scheduled", { pushLogId: row.id, attempt, nextInMs: backoffMs(attempt) });
    return;
  }

  await db.pushLog.update({
    where: { id: row.id },
    data: {
      status: attempt >= row.maxAttempts ? "DEAD_LETTER" : "FAILED",
      deviceCount, sentCount, failedCount: failedPermanent + failedTransient, skippedCount,
      attemptCount: attempt, errorCode: errorCode || "Transient", lastError: firstError,
      channel: fcmReady ? "FCM" : "VAPID",
    },
  });
  log("error", "push-dead-letter", { pushLogId: row.id, attempt, err: firstError.slice(0, 120) });
}

/** One worker tick: recover stuck rows, then process due QUEUED rows. */
export async function tickPushWorker(): Promise<void> {
  if (g.__hmsPushWorkerBusy) return;
  g.__hmsPushWorkerBusy = true;
  try {
    await recoverStuck();
    const due = await db.pushLog.findMany({
      where: { status: "QUEUED", scheduledAt: { lte: new Date() } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: CLAIM_BATCH,
    });
    for (const row of due) {
      try {
        await processOne(row.id);
      } catch (e) {
        log("error", "push-process-failed", { pushLogId: row.id, err: e instanceof Error ? e.message : String(e) });
        await db.pushLog.update({
          where: { id: row.id },
          data: { attemptCount: { increment: 1 }, lastError: "worker exception" },
        }).catch(() => undefined);
      }
    }
    await maybeCleanup();
  } catch (e) {
    log("error", "push-tick-failed", { err: e instanceof Error ? e.message : String(e) });
  } finally {
    g.__hmsPushWorkerBusy = false;
  }
}

/**
 * Safe cleanup (spec §29) — once per day inside the regular worker tick:
 *   • devices with ≥5 consecutive failures → deactivated (client re-registers
 *     a fresh token on next enable; no useful data is lost)
 *   • delivery history older than the retention window → pruned.
 * In-app notifications (the Notification table) are NEVER touched here.
 */
async function maybeCleanup(): Promise<void> {
  const now = Date.now();
  if (g.__hmsPushCleanupAt && now - g.__hmsPushCleanupAt < CLEANUP_INTERVAL_MS) return;
  g.__hmsPushCleanupAt = now;
  try {
    const prunedDevices = await db.pushDevice.updateMany({
      where: { active: true, failureCount: { gte: MAX_FAILURES_BEFORE_PRUNE } },
      data: { active: false },
    });
    const cutoff = new Date(now - PUSH_LOG_RETENTION_DAYS * 86_400_000);
    const prunedLogs = await db.pushLog.deleteMany({ where: { createdAt: { lt: cutoff }, isTest: false } });
    if (prunedDevices.count > 0 || prunedLogs.count > 0) {
      log("info", "push-cleanup", { devicesDeactivated: prunedDevices.count, logsPruned: prunedLogs.count });
    }
  } catch (e) {
    log("warn", "push-cleanup-failed", { err: e instanceof Error ? e.message : String(e) });
  }
}
