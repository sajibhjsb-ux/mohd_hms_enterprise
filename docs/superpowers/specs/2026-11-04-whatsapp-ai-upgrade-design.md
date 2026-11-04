# MOHD.HMS ENTERPRISE — WhatsApp AI-Powered Conversational Upgrade

## Intent & why
Upgrade the existing WhatsApp automation (OpenWA gateway + `src/lib/hms/whatsapp/*`) into a professional AI-powered customer-service assistant that converses naturally, understands context, asks progressive questions, retrieves real system data, performs permitted low-risk actions, and defers finance/approvals/sensitive operations to humans. Do NOT replace existing WhatsApp functionality — integrate on top.

## Constraints (non-negotiable)
- No fabrication: AI never claims an action succeeded unless the backend confirms it. No invented complaint/invoice/work-order numbers, prices, or statuses.
- AI never executes arbitrary SQL; only controlled backend tools.
- Finance/commercial/operational/admin mutations are human-only (AI explains, never performs).
- API keys stay server-side (AES-256-GCM via existing `ai/crypto.ts`); never returned to browser.
- Reuse existing services/models/auth/RBAC; do not duplicate.
- Honest provider failover (Gemini → OpenAI → Claude → NVIDIA) via existing `AiService` fallback chain; never show "Success" on failure.
- Idempotent webhooks (existing `whatsAppWebhookEvent` dedupe); loop prevention (fromMe/system messages excluded).
- Existing uncommitted changes on `main` must not be clobbered — new files/additive changes only.

## Existing assets to reuse
- OpenWA gateway client: `src/lib/hms/whatsapp/openwa.ts`, `service.ts`, `inbound.ts`, `config.ts`, `attachments.ts`, `templates.ts`, `normalize.ts`
- WhatsApp API routes: `src/app/api/v1/whatsapp/*`
- Central AI service: `src/lib/hms/ai/service.ts` (`aiGenerate`, `aiGenerateStructured`, `extractJsonObject`, fallback chain, honest status, usage logging)
- AI crypto: `src/lib/hms/ai/crypto.ts` (AES-256-GCM)
- Models: `Customer`, `Complaint`, `WorkOrder`, `Equipment`, `Invoice`, `Quotation`, `Payment`, `Location`, `WorkCatalogue`, `WhatsAppContact`, `WhatsAppConversation`, `WhatsAppMessage`, `AiConfiguration`, `AiProviderProfile`, `AiUsageLog`
- RBAC + sessions + realtime (socket.io) + workflow outbox + storage (MinIO)

## New DB models (additive migration, existing tables untouched)
- `AiConversation` — id, chatId, contactId, customerId, state (AI|HUMAN|HYBRID|CLOSED), intent, confidence, summary, missingInfo (JSON), questionsAnswered (JSON), entities (JSON), mode, createdAt, updatedAt
- `AiMessage` — id, conversationId, chatId, direction (INBOUND|OUTBOUND), role (user|assistant|system|tool), content, intent, confidence, toolCallId?, provider, model, tokens, createdAt
- `AiToolCall` — id, conversationId, messageId, toolName, args (JSON), result (JSON), status (PENDING|SUCCESS|FAILED), error, durationMs, createdAt
- `AiAction` — id, conversationId, actionType (CREATE_COMPLAINT|...), payload (JSON), status (PROPOSED|APPROVED|REJECTED|EXECUTED|FAILED), approvedById, approvedAt, result (JSON), createdAt
- `AiApproval` — id, actionId, decision (APPROVED|REJECTED), byUserId, comment, createdAt
- `AiHandover` — id, conversationId, reason, assignedToId, status (PENDING|ACTIVE|RESOLVED), createdAt, resolvedAt
- `AiSummary` — id, conversationId, content, version, messageCount, createdAt
- `AiRateLimit` — id, scope (customer|conversation|provider), key, count, windowStart, resetAt, createdAt
- `AiKnowledgeBase` — id, title, content, category, active, createdAt, updatedAt

## New services (all server-only)
1. `ai-conversation.service.ts` — load/create conversation, memory window, summary, missing-info tracking, entities
2. `ai-intent.service.ts` — intent detection + confidence (HIGH/MEDIUM/LOW) using AI service
3. `ai-questioning.service.ts` — smart progressive questioning (what's missing, don't re-ask)
4. `ai-tools.service.ts` — controlled tool registry + execution: getCustomer, getComplaints, getWorkOrder, getEquipment, getInvoice, getQuotation, getAppointment; each RBAC-gated, read-only
5. `ai-action.service.ts` — propose low-risk actions (create complaint), require confirmation for human-only gates
6. `ai-handover.service.ts` — human handover (AI/HUMAN/HYBRID mode), supervisor notification
7. `ai-rate-limit.service.ts` — per-customer/conversation/provider limits with exponential backoff
8. `ai-summary.service.ts` — conversation summarization for long threads

## New API routes (additive)
- `POST /api/v1/whatsapp/ai/converse` — main entry: receives inbound message, runs AI pipeline, returns response (+ optional tool results). Idempotent by provider message id.
- `POST /api/v1/whatsapp/ai/actions/[id]/approve` / `/reject` — staff approve/reject proposed AI action
- `GET /api/v1/whatsapp/ai/conversations` — admin list (RBAC)
- `GET /api/v1/whatsapp/ai/conversations/[id]` — conversation detail + messages
- `POST /api/v1/whatsapp/ai/conversations/[id]/mode` — switch AI/HUMAN/HYBRID
- `POST /api/v1/whatsapp/ai/conversations/[id]/handover` — trigger human handover
- `GET /api/v1/whatsapp/ai/settings` — AI settings (existing routes already cover; reuse)

## Inbound wiring
`handleInboundMessage` in `inbound.ts`: after persistence, if AI automation enabled and conversation not HUMAN/CLOSED, route through the AI converse pipeline instead of (or in addition to) the rules-first classifier. Rules remain for HUMAN keyword and quick classification; AI drives contextual replies.

## Out of scope (v1)
- Voice messages (STT/TTS) — §20, flagged for later
- RAG/document search — §42, knowledge base table added but retrieval wired later
- Camera "Take Photo" in web UI — §11, mobile-native; attachments already supported

## Phases
P1: DB models + conversation memory + intent/confidence + smart questioning + complaint confirmation
P2: Tool-calling + action approval + human handover + inbound wiring
P3: Admin API routes + dashboard sections + rate limiting + tests
