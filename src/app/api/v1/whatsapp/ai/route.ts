// MOHD.HMS ENTERPRISE — WhatsApp AI conversation list (§28).
// GET /api/v1/whatsapp/ai/conversations — RBAC whatsapp_view.
import type { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, pagedMeta, listQuery } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(async ({ req }): Promise<NextResponse> => {
  const q = listQuery(req);
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? undefined;
  const where = {
    ...(state ? { state } : {}),
    ...(q.customerId ? { customerId: q.customerId } : {}),
    ...(q.search ? { chatId: { contains: q.search } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.aiConversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      skip: q.skip, take: q.take,
      select: {
        id: true, chatId: true, state: true, mode: true, intent: true, confidence: true,
        lastMessageAt: true, createdAt: true, updatedAt: true, customerId: true,
        _count: { select: { messages: true, actions: true, handovers: true } },
      },
    }),
    db.aiConversation.count({ where }),
  ]);
  return okList(rows, pagedMeta(q.page, q.pageSize, total));
}, { permission: PERMISSIONS.whatsapp_view });
