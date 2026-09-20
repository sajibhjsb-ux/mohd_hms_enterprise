// MOHD.HMS ENTERPRISE — WhatsApp Inbox: conversation list (§56).
import type { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, pagedMeta, listQuery, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { ensureConversation } from "@/lib/hms/whatsapp/service";
import { normalizePhone } from "@/lib/hms/whatsapp/normalize";
import { z } from "zod";

export const GET = handler(async ({ req }): Promise<NextResponse> => {
  const q = listQuery(req);
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const where = {
    ...(state ? { state } : {}),
    ...(q.search ? { chatId: { contains: q.search } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.whatsAppConversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      select: {
        id: true, chatId: true, state: true, unreadCount: true, assignedAgentId: true,
        lastMessageAt: true, lastMessagePreview: true, lastInboundAt: true,
        contact: { select: { id: true, waName: true, phone: true, kind: true, automationEnabled: true } },
        customer: { select: { id: true, code: true, companyName: true, contactPerson: true } },
      },
    }),
    db.whatsAppConversation.count({ where }),
  ]);
  return okList(rows, pagedMeta(q.page, q.pageSize, total));
}, { permission: PERMISSIONS.whatsapp_view });

// PUT creates a conversation for a phone number not seen yet (admin-initiated).
const putSchema = z.object({ phone: z.string().min(6).max(30) });
export const PUT = handler(async ({ req, user }): Promise<NextResponse> => {
  const body = await parseBody(req, putSchema);
  const n = normalizePhone(body.phone);
  if (!n.ok) throw Errors.badRequest(n.reason);
  const conv = await ensureConversation(n.chatId);
  void audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_CONVERSATION_OPENED",
    resourceType: "WHATSAPP_CONVERSATION", resourceId: n.chatId, metadata: {},
  });
  return ok({ ok: true, conversationId: conv.id, chatId: n.chatId });
}, { permission: PERMISSIONS.whatsapp_send });
