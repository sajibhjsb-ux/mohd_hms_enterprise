// MOHD.HMS ENTERPRISE — WhatsApp AI conversation memory (spec §5, §21).
// Server-only. Loads / creates an AiConversation for a WhatsApp chat and manages
// the message window, summary, missing-info tracking and extracted entities.
import "server-only";
import { db } from "@/lib/db";
import type { AiConversation, AiMessage } from "@prisma/client";

export type ConversationState = "AI" | "HUMAN" | "HYBRID" | "CLOSED";
export type ConversationMode = "AI" | "HUMAN" | "HYBRID";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface AiMemoryContext {
  conversation: AiConversation;
  recentMessages: AiMessage[];
  summary: string | null;
  entities: Record<string, unknown>;
  missingInfo: string[];
  questionsAnswered: Record<string, string>;
}

/** Canonical WhatsApp chat id: "<digits>@c.us". */
export async function getOrCreateConversation({
  chatId,
  contactId,
  customerId,
}: {
  chatId: string;
  contactId?: string | null;
  customerId?: string | null;
}): Promise<AiConversation> {
  const existing = await db.aiConversation.findUnique({ where: { chatId } });
  if (existing) {
    const updates: Record<string, unknown> = {};
    if (contactId && existing.contactId !== contactId) updates.contactId = contactId;
    if (customerId && existing.customerId !== customerId) updates.customerId = customerId;
    if (Object.keys(updates).length) {
      return db.aiConversation.update({ where: { id: existing.id }, data: updates });
    }
    return existing;
  }
  return db.aiConversation.create({
    data: { chatId, contactId: contactId ?? null, customerId: customerId ?? null },
  });
}

export async function setConversationState(chatId: string, state: ConversationState): Promise<AiConversation | null> {
  const row = await db.aiConversation.findUnique({ where: { chatId } });
  if (!row) return null;
  return db.aiConversation.update({ where: { id: row.id }, data: { state } });
}

export async function setConversationMode(chatId: string, mode: ConversationMode): Promise<AiConversation | null> {
  const row = await db.aiConversation.findUnique({ where: { chatId } });
  if (!row) return null;
  return db.aiConversation.update({ where: { id: row.id }, data: { mode } });
}

export async function updateConversationIntent(chatId: string, intent: string, confidence: Confidence): Promise<void> {
  const row = await db.aiConversation.findUnique({ where: { chatId } });
  if (!row) return;
  await db.aiConversation.update({
    where: { id: row.id },
    data: { intent, confidence, lastMessageAt: new Date() },
  });
}

export async function appendMessage({
  conversationId,
  chatId,
  direction,
  role,
  content,
  intent,
  confidence,
  provider,
  model,
  tokens,
  toolCallId,
}: {
  conversationId: string;
  chatId: string;
  direction: "INBOUND" | "OUTBOUND";
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  intent?: string;
  confidence?: string;
  provider?: string;
  model?: string;
  tokens?: number;
  toolCallId?: string | null;
}): Promise<AiMessage> {
  const [msg] = await db.$transaction([
    db.aiMessage.create({
      data: {
        conversationId, chatId, direction, role, content,
        intent: intent ?? "", confidence: confidence ?? "",
        provider: provider ?? "", model: model ?? "", tokens: tokens ?? 0,
        toolCallId: toolCallId ?? null,
      },
    }),
    db.aiConversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), updatedAt: new Date() },
    }),
  ]);
  return msg as unknown as AiMessage;
}

/** Recent messages (newest first) used as the AI context window. */
export async function getMemoryWindow(conversationId: string, limit = 20): Promise<AiMessage[]> {
  return db.aiMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Full conversation memory context for building the AI prompt. */
export async function getMemoryContext(chatId: string): Promise<AiMemoryContext | null> {
  const conv = await db.aiConversation.findUnique({ where: { chatId } });
  if (!conv) return null;
  const recent = await getMemoryWindow(conv.id, 30);
  const summary = await db.aiSummary.findFirst({
    where: { conversationId: conv.id },
    orderBy: { version: "desc" },
  });
  let entities: Record<string, unknown> = {};
  try { entities = JSON.parse(conv.entities ?? "{}"); } catch { entities = {}; }
  let missingInfo: string[] = [];
  try { missingInfo = JSON.parse(conv.missingInfo ?? "[]"); } catch { missingInfo = []; }
  let questionsAnswered: Record<string, string> = {};
  try { questionsAnswered = JSON.parse(conv.questionsAnswered ?? "{}"); } catch { questionsAnswered = {}; }
  return {
    conversation: conv,
    recentMessages: recent.reverse(),
    summary: summary?.content ?? null,
    entities,
    missingInfo,
    questionsAnswered,
  };
}

export async function setEntities(chatId: string, entities: Record<string, unknown>): Promise<void> {
  const row = await db.aiConversation.findUnique({ where: { chatId } });
  if (!row) return;
  await db.aiConversation.update({
    where: { id: row.id },
    data: { entities: JSON.stringify(entities) },
  });
}

export async function setMissingInfo(chatId: string, missingInfo: string[]): Promise<void> {
  const row = await db.aiConversation.findUnique({ where: { chatId } });
  if (!row) return;
  await db.aiConversation.update({
    where: { id: row.id },
    data: { missingInfo: JSON.stringify(missingInfo) },
  });
}

export async function setQuestionsAnswered(chatId: string, qa: Record<string, string>): Promise<void> {
  const row = await db.aiConversation.findUnique({ where: { chatId } });
  if (!row) return;
  await db.aiConversation.update({
    where: { id: row.id },
    data: { questionsAnswered: JSON.stringify(qa) },
  });
}

export async function upsertSummary(conversationId: string, content: string, messageCount: number): Promise<void> {
  const last = await db.aiSummary.findFirst({ where: { conversationId }, orderBy: { version: "desc" } });
  await db.aiSummary.create({
    data: {
      conversationId, content,
      version: (last?.version ?? 0) + 1,
      messageCount,
    },
  });
}

export async function listConversations({
  state,
  customerId,
  limit = 50,
  offset = 0,
}: { state?: string; customerId?: string; limit?: number; offset?: number }): Promise<AiConversation[]> {
  return db.aiConversation.findMany({
    where: { ...(state ? { state } : {}), ...(customerId ? { customerId } : {}) },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    skip: offset,
  });
}
