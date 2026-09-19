// MOHD.HMS ENTERPRISE — WhatsApp conversation detail (§56) + staff reply (§57)
// + state control (human handoff / automation re-enable, §26).
// GET    = conversation + messages (media refs only — bytes in MinIO).
// POST   = staff reply through WhatsAppService (RBAC-gated).
// PATCH  = conversation state (HUMAN ↔ BOT) / assigned agent.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { queueDirect, ensureConversation } from "@/lib/hms/whatsapp/service";

function idFromUrl(req: Request): string {
  return new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
}

export const GET = handler(async ({ req }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const conv = await db.whatsAppConversation.findUnique({
    where: { id },
    select: {
      id: true, chatId: true, state: true, unreadCount: true, assignedAgentId: true,
      lastMessageAt: true, lastInboundAt: true,
      contact: { select: { id: true, waName: true, phone: true, kind: true, automationEnabled: true, customerId: true } },
      customer: { select: { id: true, code: true, companyName: true, contactPerson: true } },
    },
  });
  if (!conv) throw Errors.notFound("Conversation not found.");
  const messages = await db.whatsAppMessage.findMany({
    where: { chatId: conv.chatId },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: {
      id: true, direction: true, status: true, type: true, body: true,
      mediaMimetype: true, mediaFilename: true, mediaSize: true,
      templateKey: true, relatedType: true, relatedId: true,
      isTest: true, sentAt: true, createdAt: true, lastError: true,
    },
  });
  // Opening a conversation clears the unread badge (staff has seen it).
  await db.whatsAppConversation.updateMany({ where: { id }, data: { unreadCount: 0 } });
  return ok({ ...conv, messages });
}, { permission: PERMISSIONS.whatsapp_view });

const replySchema = z.object({ message: z.string().min(1).max(2000) });

export const POST = handler(async ({ req, user }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const conv = await db.whatsAppConversation.findUnique({ where: { id }, select: { chatId: true, contactId: true } });
  if (!conv) throw Errors.notFound("Conversation not found.");
  const body = await parseBody(req, replySchema);
  const result = await queueDirect({
    templateKey: "GENERAL_NOTIFICATION",
    toChatId: conv.chatId,
    category: "SUPPORT",
    data: {
      NOTIFICATION_TITLE: "", // staff reply renders as free text — no placeholders
      NOTIFICATION_MESSAGE: body.message,
      USER_NAME: user.name,
    },
    relatedType: "WHATSAPP_CONVERSATION", relatedId: conv.chatId,
  });
  if (!result.ok) throw Errors.badRequest(result.reason ?? "Could not queue the reply.");
  // Staff replies are free text, not templates: write the body directly.
  await db.whatsAppMessage.update({ where: { id: result.id! }, data: { body: body.message, templateKey: "" } });
  await db.whatsAppConversation.update({
    where: { id },
    data: { lastMessageAt: new Date(), lastMessagePreview: body.message.slice(0, 80) },
  });
  void audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_REPLY_SENT",
    resourceType: "WHATSAPP_CONVERSATION", resourceId: conv.chatId, metadata: {},
  });
  return ok({ ok: true, messageId: result.id });
}, { permission: PERMISSIONS.whatsapp_send });

const patchSchema = z.object({
  state: z.enum(["BOT", "HUMAN", "CLOSED"]).optional(),
  assignedAgentId: z.string().max(64).optional(),
  automationEnabled: z.boolean().optional(),
});

export const PATCH = handler(async ({ req, user }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const body = await parseBody(req, patchSchema);
  const conv = await db.whatsAppConversation.findUnique({ where: { id }, select: { id: true, chatId: true, contactId: true } });
  if (!conv) throw Errors.notFound("Conversation not found.");
  await db.whatsAppConversation.update({
    where: { id },
    data: { ...(body.state ? { state: body.state } : {}), ...(body.assignedAgentId !== undefined ? { assignedAgentId: body.assignedAgentId } : {}) },
  });
  if (body.automationEnabled !== undefined && conv.contactId) {
    await db.whatsAppContact.update({ where: { id: conv.contactId }, data: { automationEnabled: body.automationEnabled } });
  }
  void audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_CONVERSATION_UPDATED",
    resourceType: "WHATSAPP_CONVERSATION", resourceId: conv.chatId,
    metadata: { state: body.state, automationEnabled: body.automationEnabled },
  });
  return ok({ ok: true });
}, { permission: PERMISSIONS.whatsapp_send });

