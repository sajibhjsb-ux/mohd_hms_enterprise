// MOHD.HMS ENTERPRISE — WhatsApp AI conversation detail + mode control (§28).
// GET    /api/v1/whatsapp/ai/conversation/[id] — conversation, messages, actions.
// PATCH  /api/v1/whatsapp/ai/conversation/[id] — switch AI/HUMAN/HYBRID mode.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { setConversationMode, setConversationState, getMemoryContext } from "@/lib/hms/ai/conversation";
import { triggerHandover } from "@/lib/hms/ai/handover";

function idFromUrl(req: Request): string {
  return new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
}

const patchSchema = z.object({
  mode: z.enum(["AI", "HUMAN", "HYBRID"]).optional(),
});

export const GET = handler(async ({ req }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const conv = await db.aiConversation.findUnique({
    where: { id },
    select: {
      id: true, chatId: true, state: true, mode: true, intent: true, confidence: true,
      missingInfo: true, questionsAnswered: true, entities: true, lastMessageAt: true,
      createdAt: true, updatedAt: true, customerId: true,
    },
  });
  if (!conv) throw Errors.notFound("Conversation not found.");
  const messages = await db.aiMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true, direction: true, role: true, content: true, intent: true, confidence: true, provider: true, model: true, createdAt: true },
  });
  const actions = await db.aiAction.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, actionType: true, status: true, result: true, error: true, approvedById: true, approvedAt: true, createdAt: true },
  });
  const handovers = await db.aiHandover.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, reason: true, status: true, assignedToId: true, createdAt: true, resolvedAt: true },
  });
  return ok({ conversation: conv, messages, actions, handovers });
}, { permission: PERMISSIONS.whatsapp_view });

export const PATCH = handler(async ({ req, user }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const conv = await db.aiConversation.findUnique({ where: { id }, select: { id: true, chatId: true } });
  if (!conv) throw Errors.notFound("Conversation not found.");
  const body = await parseBody(req, patchSchema);
  if (body.mode) {
    await setConversationMode(conv.chatId, body.mode);
    await audit({
      actorId: user.id, actorEmail: user.email, action: "WHATSAPP_AI_MODE_CHANGED",
      resourceType: "AI_CONVERSATION", resourceId: id, metadata: { mode: body.mode, chatId: conv.chatId },
    }).catch(() => undefined);
  }
  return ok({ ok: true });
}, { permission: PERMISSIONS.whatsapp_send });
