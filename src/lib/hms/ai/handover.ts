// MOHD.HMS ENTERPRISE — AI human handover (spec §15).
// Server-only. Sets a conversation to HUMAN (bot silent), records the handover,
// and notifies supervisors/admins. AI must not send further messages unless a
// staff member explicitly re-enables AI mode.
import "server-only";
import { db } from "@/lib/db";
import { notifyRole } from "@/lib/hms/services";
import { audit } from "@/lib/hms/services";
import { appendMessage, setConversationState } from "./conversation";

export type HandoverReason = "HUMAN_REQUEST" | "AI_FAILURE" | "MANUAL" | "ESCALATION";

export async function triggerHandover({
  conversationId,
  chatId,
  reason,
  assignedToId,
}: {
  conversationId: string;
  chatId: string;
  reason: HandoverReason;
  assignedToId?: string | null;
}): Promise<{ conversationId: string; handoverId: string } | { ok: false; code: string; message: string }> {
  const conv = await db.aiConversation.findUnique({ where: { id: conversationId } });
  if (!conv) return { ok: false, code: "AI_CONVERSATION_NOT_FOUND", message: "Conversation not found." };
  if (conv.state === "HUMAN") return { conversationId, handoverId: "" };

  await setConversationState(chatId, "HUMAN");

  const handover = await db.aiHandover.create({
    data: { conversationId, reason, assignedToId: assignedToId ?? null, status: "ACTIVE" },
  });

  const customer = conv.customerId ? await db.customer.findUnique({ where: { id: conv.customerId }, select: { contactPerson: true, phone: true } }) : null;

  await notifyRole("SUPERVISOR", {
    title: "WhatsApp human handover",
    message: `Customer ${customer?.contactPerson || chatId} (${chatId}) requested human support. Reason: ${reason}.`,
    type: "WARNING", resourceType: "WHATSAPP_CONVERSATION", resourceId: conversationId,
  }).catch(() => undefined);
  await notifyRole("ADMIN", {
    title: "WhatsApp human handover",
    message: `Customer ${customer?.contactPerson || chatId} (${chatId}) handed over to a human.`,
    type: "WARNING", resourceType: "WHATSAPP_CONVERSATION", resourceId: conversationId,
  }).catch(() => undefined);

  await audit({ action: "WHATSAPP_AI_HUMAN_HANDOVER", resourceType: "AI_CONVERSATION", resourceId: conversationId, metadata: { chatId, reason, assignedToId } }).catch(() => undefined);

  await appendMessage({
    conversationId, chatId, direction: "OUTBOUND", role: "assistant",
    content: "Sure. I'll connect you with our team. A colleague will get back to you shortly.",
    provider: "system", model: "system", tokens: 0,
  });

  return { conversationId, handoverId: handover.id };
}

export async function resolveHandover(conversationId: string, byUserId: string): Promise<void> {
  const conv = await db.aiConversation.findUnique({ where: { id: conversationId } });
  if (!conv) return;
  await db.aiHandover.updateMany({
    where: { conversationId, status: "ACTIVE" },
    data: { status: "RESOLVED" },
  });
  await db.aiConversation.update({ where: { id: conversationId }, data: { state: "AI", mode: "AI" } });
  await audit({ action: "WHATSAPP_AI_HANDOVER_RESOLVED", resourceType: "AI_CONVERSATION", resourceId: conversationId, metadata: { byUserId } }).catch(() => undefined);
}

export async function setAiMode(conversationId: string, mode: "AI" | "HUMAN" | "HYBRID"): Promise<void> {
  const conv = await db.aiConversation.findUnique({ where: { id: conversationId } });
  if (!conv) return;
  const state = mode === "HUMAN" ? "HUMAN" : "AI";
  await db.aiConversation.update({ where: { id: conversationId }, data: { mode, state } });
}
