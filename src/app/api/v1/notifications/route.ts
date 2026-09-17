import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody } from "@/lib/hms/api";


export const GET = handler(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const take = Math.min(50, Math.max(1, parseInt(sp.get("take") ?? "20", 10) || 20));
  const [items, unread] = await Promise.all([
    db.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take }),
    db.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);
  return okList(items, { unread });
});

const patchSchema = z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() });

/** Mark notifications read (specific ids or all). */
export const PATCH = handler(async ({ req, user }) => {
  const { ids, all } = await parseBody(req, patchSchema);
  const where = all ? { userId: user.id, readAt: null } : { userId: user.id, id: { in: ids ?? [] } };
  const res = await db.notification.updateMany({ where, data: { readAt: new Date() } });
  return ok({ updated: res.count });
});
