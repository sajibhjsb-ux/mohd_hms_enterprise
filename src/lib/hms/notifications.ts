// MOHD.HMS ENTERPRISE — Notification gateway shared helpers (server-only).
// Central business logic behind PATCH /api/v1/notifications (mark read) and
// the read-all alias. Both routes reuse these so the two paths behave identically:
//   • only actually-unread rows are counted as "updated"
//   • the authoritative unread count is returned so clients never guess
//   • a NOTIFICATION_READ outbox event refreshes the recipient's open panels
import "server-only";
import { db } from "@/lib/db";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

export type MarkReadResult = { updated: number; unread: number };

/** Authoritative unread count for a user. */
export async function unreadCount(userId: string): Promise<number> {
  return db.notification.count({ where: { userId, readAt: null } });
}

/** Mark specific notifications read (scoped to the caller's own rows). */
async function markReadScoped(userId: string, where: Parameters<typeof db.notification.updateMany>[0]["where"]): Promise<MarkReadResult> {
  const res = await db.notification.updateMany({ where, data: { readAt: new Date() } });
  const unread = await unreadCount(userId);
  return { updated: res.count, unread };
}

/** Mark specific notifications read (only the caller's own unread rows count). */
export async function markNotificationsRead(userId: string, ids: string[]): Promise<MarkReadResult> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return { updated: 0, unread: await unreadCount(userId) };
  const result = await markReadScoped(userId, { userId, readAt: null, id: { in: unique } });
  if (result.updated > 0) await notifyReadEvent(userId, result, { ids: unique });
  return result;
}

/** Mark every unread notification read. Emits + audits the bulk action. */
export async function markAllNotificationsRead(userId: string, actorEmail = ""): Promise<MarkReadResult> {
  const result = await markReadScoped(userId, { userId, readAt: null });
  if (result.updated > 0) {
    await notifyReadEvent(userId, result, { all: true });
    await db.auditLog.create({
      data: {
        actorId: userId,
        actorEmail,
        action: "NOTIFICATIONS_MARKED_ALL_READ",
        resourceType: "NOTIFICATION",
        metadata: JSON.stringify({ updated: result.updated, unread: result.unread }),
      },
    }).catch(() => undefined);
  }
  return result;
}

async function notifyReadEvent(userId: string, result: MarkReadResult, extra: Record<string, unknown>): Promise<void> {
  await emit({
    type: EVENT_TYPES.NOTIFICATION_READ,
    resourceType: "NOTIFICATION",
    payload: { userIds: [userId], updated: result.updated, unread: result.unread, ...extra },
    actorType: "USER",
    actorId: userId,
  });
}
