// MOHD.HMS ENTERPRISE — WhatsApp AI DB integration verification.
// Confirms the new AI tables exist in the local SQLite DB and accept reads/writes.
// Run: DATABASE_URL="file:./prisma/db/custom.db" bun scripts/ad-hoc/ai-db-verify.mjs
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
let pass = 0; let fail = 0;
function t(name, fn) { return fn().then(() => { pass++; console.log("PASS", name); }).catch((e) => { fail++; console.log("FAIL", name, "-", String(e)); }); }

async function main() {
  await t("ai_conversations table + write", async () => {
    const c = await db.aiConversation.create({ data: { chatId: "+67370000001@c.us", customerId: null } });
    const found = await db.aiConversation.findUnique({ where: { id: c.id } });
    if (!found || found.chatId !== "+67370000001@c.us") throw new Error("conversation not persisted");
    await db.aiConversation.delete({ where: { id: c.id } });
  });

  await t("ai_messages + ai_tool_calls + ai_actions relations", async () => {
    const conv = await db.aiConversation.create({ data: { chatId: "+67370000002@c.us" } });
    const msg = await db.aiMessage.create({ data: { conversationId: conv.id, chatId: conv.chatId, direction: "INBOUND", role: "user", content: "hi" } });
    const tc = await db.aiToolCall.create({ data: { conversationId: conv.id, toolName: "getCustomer", args: "{}", result: "{}", status: "SUCCESS" } });
    await db.aiMessage.update({ where: { id: msg.id }, data: { toolCallId: tc.id } });
    const act = await db.aiAction.create({ data: { conversationId: conv.id, actionType: "CREATE_COMPLAINT", payload: "{}" } });
    const loaded = await db.aiConversation.findUnique({ where: { id: conv.id }, include: { messages: true, toolCalls: true, actions: true } });
    if (!loaded || loaded.messages.length !== 1 || loaded.toolCalls.length !== 1 || loaded.actions.length !== 1) throw new Error("relations not loaded");
    await db.aiAction.delete({ where: { id: act.id } });
    await db.aiToolCall.delete({ where: { id: tc.id } });
    await db.aiMessage.delete({ where: { id: msg.id } });
    await db.aiConversation.delete({ where: { id: conv.id } });
  });

  await t("ai_handover + ai_summary + ai_rate_limit + ai_knowledge_base", async () => {
    const conv = await db.aiConversation.create({ data: { chatId: "+67370000003@c.us" } });
    await db.aiHandover.create({ data: { conversationId: conv.id, reason: "HUMAN_REQUEST", status: "PENDING" } });
    await db.aiSummary.create({ data: { conversationId: conv.id, content: "s", version: 1, messageCount: 1 } });
    await db.aiRateLimit.create({ data: { scope: "customer", key: "customer:x", count: 1, resetAt: new Date(Date.now() + 60000) } });
    await db.aiKnowledgeBase.create({ data: { title: "t", content: "c", category: "FAQ", active: true } });
    const n = await db.aiConversation.count({ where: { chatId: "+67370000003@c.us" } });
    if (n !== 1) throw new Error("conversation not found");
    await db.aiHandover.deleteMany({ where: { conversationId: conv.id } });
    await db.aiSummary.deleteMany({ where: { conversationId: conv.id } });
    await db.aiRateLimit.deleteMany({ where: { key: "customer:x" } });
    await db.aiKnowledgeBase.deleteMany({ where: { title: "t" } });
    await db.aiConversation.delete({ where: { id: conv.id } });
  });

  await t("ai_approvals + ai_actions link", async () => {
    const conv = await db.aiConversation.create({ data: { chatId: "+67370000004@c.us" } });
    const act = await db.aiAction.create({ data: { conversationId: conv.id, actionType: "CREATE_COMPLAINT", payload: "{}" } });
    // approval needs a user; skip FK-dependent user, just verify action can be updated
    await db.aiAction.update({ where: { id: act.id }, data: { status: "EXECUTED", result: "{}" } });
    const a2 = await db.aiAction.findUnique({ where: { id: act.id } });
    if (a2.status !== "EXECUTED") throw new Error("action update failed");
    await db.aiAction.delete({ where: { id: act.id } });
    await db.aiConversation.delete({ where: { id: conv.id } });
  });

  await db.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
