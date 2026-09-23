// MOHD.HMS ENTERPRISE — Notifications list & search API.
// GET /api/v1/notifications — the recipient's notifications, newest first.
// Query params:
//   take   default 20, max 50             — page size
//   cursor last item id (keyset pagination)
//   unread=1                              — unread only
//   search                                — search across title/message/type
//   meta: { unread, total, hasMore, nextCursor }

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList } from "@/lib/hms/api";

export const GET = handler(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const take = Math.min(50, Math.max(1, parseInt(sp.get("take") ?? "20", 10) || 20));
  const cursor = sp.get("cursor")?.trim() || undefined;
  const unreadOnly = sp.get("unread") === "1";
  const search = sp.get("search")?.trim() || "";

  const where: Record<string, unknown> = { userId: user.id };

  if (unreadOnly) {
    where.readAt = null;
  }

  if (search) {
    where.OR = [
      { title: { contains: search } },
      { message: { contains: search } },
      { type: { contains: search } },
    ];
  }

  const [items, total, unread] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    db.notification.count({ where }),
    // Global unread count for the CURRENT USER (independent of any filter) —
    // the header bell badge reads meta.unread and must reflect the real
    // unread backlog on every load AND on every NOTIFICATION_CREATED event
    // (realtime refetch). Contract documented above.
    db.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);

  const hasMore = items.length > take;
  const page = hasMore ? items.slice(0, take) : items;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : undefined;

  return okList(page, {
    unread,
    total,
    hasMore,
    nextCursor: nextCursor ?? null,
  });
});