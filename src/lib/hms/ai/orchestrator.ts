// MOHD.HMS ENTERPRISE — WhatsApp AI orchestrator (spec §1-§16, §22, §27, §30, §33).
// Server-only. Single entry point for an inbound WhatsApp message. Runs the full
// AI pipeline: rate limit → memory → intent → entities/questioning → tools →
// response → persist. Never fabricates; every action is confirmed by the backend.
import "server-only";
import { aiGenerate, type AiTextResult } from "./service";
import { getOrCreateConversation, appendMessage, getMemoryContext, updateConversationIntent, setEntities, setMissingInfo } from "./conversation";
import { detectIntent, isComplaintRelated, isHumanRequest, type AiIntent } from "./intent";
import { extractAndUpdate, missingFields, nextField, nextQuestion, recordAnswer, type ComplaintField } from "./questioning";
import { executeTool, type AiToolContext, type AiToolName } from "./tools";
import { proposeCreateComplaint, getProposedAction, confirmCreateComplaint, rejectAction } from "./action";
import { triggerHandover, setAiMode } from "./handover";

export type ConverseInput = {
  chatId: string;
  text: string;
  customerId?: string | null;
  contactId?: string | null;
  providerOverride?: string | null;
};

export type ConverseOutput = {
  reply: string;
  intent: AiIntent;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  provider: string;
  model: string;
  action?: { type: string; status: string; complaintCode?: string };
  handover?: boolean;
};

const CONFIRM_RE = /^(yes|yeah|yep|y|confirm|ok|okay|correct|that.?s right|right|proceed|go ahead|create it|do it)\b/i;

const RESPONSE_SYSTEM = `You are a professional MOHD.HMS ENTERPRISE customer-service representative on WhatsApp.

Tone: professional, friendly, concise, human-like, helpful, context-aware. Avoid robotic templates. Use emojis only when appropriate. Keep replies short.

SAFETY (never break these):
- Never invent complaint/invoice/work-order numbers, prices, technician names, or statuses.
- Only state what the tool results or confirmed facts actually say.
- If you don't know, say so and offer to connect the customer with the team.
- Finance (payments, refunds, invoice changes), final quotations, contracts and closing work orders are human-only — explain, never perform.
- Ask only the questions needed; never repeat what the customer already answered.
- When proposing a complaint, summarize what you have and ask the customer to confirm before creating it.`;

/** Rate-limit key per customer + conversation. */
function rateKey(customerId: string | null, chatId: string): string {
  return `ai_converse:${customerId ?? "unknown"}:${chatId}`;
}

const rateBuckets = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 15; // per customer per conversation per minute

function rateLimited(customerId: string | null, chatId: string): boolean {
  const now = Date.now();
  const key = rateKey(customerId, chatId);
  const arr = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) { rateBuckets.set(key, arr); return true; }
  arr.push(now); rateBuckets.set(key, arr);
  return false;
}

function isConfirmation(text: string): boolean {
  return CONFIRM_RE.test(text.trim()) && text.trim().split(/\s+/).length <= 4;
}

function isHandoverKeyword(text: string): boolean {
  const t = text.trim().toUpperCase();
  return /^(HUMAN|AGENT|SUPPORT|OPERATOR|TALK TO (A HUMAN|AN AGENT|SUPPORT|HUMAN)|I WANT A HUMAN|CALL ME|I DON'T WANT AI)\b/.test(t);
}

function complaintSummary(payload: { location?: string; workCategory?: string; issue?: string; description?: string; equipment?: string }): string {
  const parts: string[] = [];
  if (payload.location) parts.push(`Location: ${payload.location}`);
  if (payload.workCategory) parts.push(`Category: ${payload.workCategory}`);
  if (payload.equipment) parts.push(`Equipment: ${payload.equipment}`);
  if (payload.issue) parts.push(`Issue: ${payload.issue}`);
  return parts.length ? parts.join("\n") : "—";
}

export async function converse(input: ConverseInput): Promise<ConverseOutput> {
  const { chatId, text, customerId, contactId, providerOverride } = input;

  // Rate limit (§31)
  if (rateLimited(customerId ?? null, chatId)) {
    return {
      reply: "I'm receiving a lot of messages right now. Please wait a moment, then try again.",
      intent: "UNKNOWN", confidence: "LOW", provider: "", model: "",
    };
  }

  // Get/create conversation + memory
  const conv = await getOrCreateConversation({ chatId, contactId, customerId });
  if (conv.state === "CLOSED") {
    return { reply: "", intent: "UNKNOWN", confidence: "LOW", provider: "", model: "" };
  }

  // Append the user message
  await appendMessage({ conversationId: conv.id, chatId, direction: "INBOUND", role: "user", content: text });

  const memory = await getMemoryContext(chatId);
  if (!memory) {
    return { reply: "I'm having trouble loading our conversation. Please try again.", intent: "UNKNOWN", confidence: "LOW", provider: "", model: "" };
  }

  // Human handoff: bot silent (§15)
  if (conv.state === "HUMAN") {
    return { reply: "", intent: "UNKNOWN", confidence: "LOW", provider: "", model: "", handover: true };
  }

  // Intent + confidence (§6, §16)
  const intentRes = await detectIntent({ text, conversationId: conv.id, providerOverride: providerOverride as any });
  await updateConversationIntent(chatId, intentRes.intent, intentRes.confidence);

  // Human handover request (§15)
  if (isHumanRequest(intentRes.intent) || isHandoverKeyword(text)) {
    const hv = await triggerHandover({ conversationId: conv.id, chatId, reason: "HUMAN_REQUEST" });
    if ("ok" in hv) {
      return { reply: "I'll connect you with our team right away.", intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model, handover: true };
    }
    return { reply: "Sure. I'll connect you with our team.", intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model, handover: true };
  }

  const ctx: AiToolContext = { customerId: customerId ?? null, userId: undefined };

  // Extract entities + update missing info (§7)
  const extraction = await extractAndUpdate({ chatId, text, providerOverride: providerOverride as any });

  // If there's a pending complaint action and the customer confirms → execute it (§9)
  const pending = await getProposedAction(conv.id);
  if (pending && pending.actionType === "CREATE_COMPLAINT" && isConfirmation(text)) {
    const confirmed = await confirmCreateComplaint(pending.id, customerId ?? "");
    if (confirmed.ok) {
      await appendMessage({ conversationId: conv.id, chatId, direction: "OUTBOUND", role: "assistant", content: `Your complaint ${confirmed.complaintCode} has been created. Our team will attend to it.`, provider: "system", model: "system", tokens: 0 });
      return { reply: `Your complaint ${confirmed.complaintCode} has been created. Our team will attend to it.`, intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model, action: { type: "CREATE_COMPLAINT", status: "EXECUTED", complaintCode: confirmed.complaintCode } };
    }
    return { reply: "I couldn't complete the complaint right now. I'll connect you with our team.", intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model, action: { type: "CREATE_COMPLAINT", status: "FAILED" } };
  }

  // Complaint / service request flow (§7, §9)
  if (isComplaintRelated(intentRes.intent) && customerId) {
    const missing = missingFields({ missingInfo: memory.missingInfo, entities: extraction.entities });
    if (missing.length > 0) {
      const { field, question, askedAlready } = await nextQuestion({ chatId, missing });
      if (field && question) {
        await recordAnswer(chatId, field, text);
        await setMissingInfo(chatId, missing.filter((f) => f !== field));
        await appendMessage({ conversationId: conv.id, chatId, direction: "OUTBOUND", role: "assistant", content: question, provider: "system", model: "system", tokens: 0 });
        return { reply: question, intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model };
      }
      if (field && askedAlready) {
        // Already asked; move on / generate a natural nudge
        const nudge = "Thank you. Is there anything else you'd like to add before I submit this?";
        await appendMessage({ conversationId: conv.id, chatId, direction: "OUTBOUND", role: "assistant", content: nudge, provider: "system", model: "system", tokens: 0 });
        return { reply: nudge, intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model };
      }
    }

    // All required info present → propose complaint (customer must confirm)
    const entities = extraction.entities as { location?: string; workCategory?: string; issue?: string; description?: string; equipment?: string };
    if (!pending) {
      try {
        const title = entities.issue || "Maintenance request";
        const description = entities.description || entities.issue || "Service request via WhatsApp";
        const created = await proposeCreateComplaint({
          conversationId: conv.id,
          chatId,
          customerId: customerId ?? "",
          payload: {
            customerId: customerId ?? "",
            title,
            description,
            priority: "MEDIUM",
            equipmentId: entities.equipment ?? null,
            workCatalogue: entities.workCategory ?? "",
            catalogueIssue: entities.issue ?? "",
          },
        });
        await appendMessage({ conversationId: conv.id, chatId, direction: "OUTBOUND", role: "assistant", content: `I can create a maintenance complaint for you.\n\nI have:\n${complaintSummary(entities)}\n\nCould you confirm this is correct?`, provider: "system", model: "system", tokens: 0 });
        return { reply: `I can create a maintenance complaint for you.\n\nI have:\n${complaintSummary(entities)}\n\nCould you confirm this is correct?`, intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model, action: { type: "CREATE_COMPLAINT", status: "PROPOSED" } };
      } catch {
        return { reply: "I wasn't able to prepare that complaint. I'll connect you with our team.", intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model };
      }
    }
    // Pending exists but not a confirmation → restate the summary
    const pPayload = JSON.parse(pending.payload ?? "{}") as { location?: string; workCategory?: string; issue?: string };
    const restate = `I have:\n${complaintSummary(pPayload)}\n\nPlease confirm (yes/no) before I submit it.`;
    await appendMessage({ conversationId: conv.id, chatId, direction: "OUTBOUND", role: "assistant", content: restate, provider: "system", model: "system", tokens: 0 });
    return { reply: restate, intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model, action: { type: "CREATE_COMPLAINT", status: "PROPOSED" } };
  }

  // Information enquiries → retrieve real data via tools (§12)
  if (["INVOICE_ENQUIRY", "WORK_ORDER_ENQUIRY", "COMPLAINT", "STATUS", "GENERAL_ENQUIRY"].includes(intentRes.intent) && customerId) {
    const toolResult = await retrieveInfo(intentRes.intent, text, ctx);
    if (toolResult.ok) {
      const dataText = summarizeToolData(intentRes.intent, toolResult.data);
      const reply = dataText || "I don't have that information available right now. I'll connect you with our team.";
      await appendMessage({ conversationId: conv.id, chatId, direction: "OUTBOUND", role: "assistant", content: reply, provider: intentRes.provider, model: intentRes.model, tokens: 0 });
      return { reply, intent: intentRes.intent, confidence: intentRes.confidence, provider: intentRes.provider, model: intentRes.model };
    }
  }

  // General conversation → generate a natural AI response with memory context
  const history = memory.recentMessages.map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`).join("\n");
  const summaryLine = memory.summary ? `Conversation summary: ${memory.summary}\n` : "";
  const missingLine = memory.missingInfo.length ? `Still needed: ${memory.missingInfo.join(", ")}.\n` : "";

  let gen: AiTextResult;
  try {
    gen = await aiGenerate({
      feature: "whatsapp_converse",
      system: `${RESPONSE_SYSTEM}\n\n${summaryLine}${missingLine}`,
      prompt: `Recent conversation:\n${history}\n\nCustomer: ${text}\n\nReply now:`,
      temperature: 0.5,
      timeoutMs: 15000,
      providerOverride: providerOverride as any,
    });
  } catch {
    gen = { ok: false, code: "AI_SERVICE_UNAVAILABLE", message: "The assistant is temporarily unavailable.", provider: "", model: "", requestId: "", durationMs: 0 };
  }

  if (!gen.ok) {
    const fallback = "I'm having trouble reaching my assistant right now. I'll connect you with our team.";
    await appendMessage({ conversationId: conv.id, chatId, direction: "OUTBOUND", role: "assistant", content: fallback, provider: "system", model: "system", tokens: 0 });
    return { reply: fallback, intent: intentRes.intent, confidence: "LOW", provider: gen.provider, model: gen.model };
  }

  await appendMessage({ conversationId: conv.id, chatId, direction: "OUTBOUND", role: "assistant", content: gen.text, provider: gen.provider, model: gen.model, tokens: gen.usage?.totalTokens ?? 0 });
  return { reply: gen.text, intent: intentRes.intent, confidence: intentRes.confidence, provider: gen.provider, model: gen.model };
}

async function retrieveInfo(intent: AiIntent, text: string, ctx: AiToolContext): Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string }> {
  // Extract an id from the message if present (complaint WO invoice quotation code).
  const idMatch = text.match(/\b(CPT|WO|INV|QTN)-[A-Z0-9-]+\b/i);
  if (intent === "INVOICE_ENQUIRY") {
    if (idMatch) return executeTool(ctx, "getInvoice", { invoiceId: idMatch[0] });
    return executeTool(ctx, "getComplaints", { customerId: ctx.customerId ?? "" }); // fallback list
  }
  if (intent === "WORK_ORDER_ENQUIRY") {
    if (idMatch) return executeTool(ctx, "getWorkOrder", { workOrderId: idMatch[0] });
    return executeTool(ctx, "getComplaints", { customerId: ctx.customerId ?? "" });
  }
  if (intent === "COMPLAINT") {
    return executeTool(ctx, "getComplaints", { customerId: ctx.customerId ?? "" });
  }
  return { ok: false, code: "AI_NO_TOOL", message: "No applicable tool." };
}

function summarizeToolData(intent: AiIntent, data: unknown): string {
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length === 0) return "You have no records on file.";
  const lines = arr.map((item: any) => {
    if (!item || typeof item !== "object") return "- " + String(item);
    if (item.code) return `${item.code}: ${item.status || "n/a"}`;
    return JSON.stringify(item).slice(0, 120);
  });
  const intro = intent === "INVOICE_ENQUIRY" ? "Your invoices:\n" : intent === "WORK_ORDER_ENQUIRY" ? "Your work orders:\n" : "Your complaints:\n";
  return intro + lines.join("\n");
}
