import { handler, ok } from "@/lib/hms/api";
import { markAllNotificationsRead } from "@/lib/hms/notifications";

/**
 * PATCH /api/v1/notifications/read-all — mark every unread notification read.
 * Dedicated alias used by the header dropdown (the canonical PATCH
 * /api/v1/notifications with { all: true } also works — both share the same
 * business logic). Response data: { updated, unread }.
 */
export const PATCH = handler(async ({ user }) => {
  return ok(await markAllNotificationsRead(user.id, user.email));
});