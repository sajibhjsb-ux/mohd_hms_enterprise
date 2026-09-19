// MOHD.HMS ENTERPRISE — WhatsApp integration type vocabulary.
// Mirrors src/lib/hms/email/types.ts conventions: status vocabularies are
// TS-side consts; SQLite stores plain strings (no enum blocks in this schema).

// Outbound delivery states (§29). RECEIVED marks inbound messages. DELIVERED /
// READ are ONLY ever set from OpenWA message.ack receipts — never assumed.
export const WHATSAPP_STATUSES = [
  "QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "RECEIVED", "FAILED", "CANCELED",
] as const;
export type WhatsAppStatus = (typeof WHATSAPP_STATUSES)[number];

// OpenWA session.status values (docs/06-api-specification.md §session.status).
export const OPENWA_SESSION_STATUSES = [
  "created", "initializing", "qr_ready", "authenticating", "ready",
  "disconnected", "action_required", "failed",
] as const;
export type OpenWaSessionStatus = (typeof OPENWA_SESSION_STATUSES)[number];

// UI-facing connection states (§9) mapped honestly from OpenWA statuses.
export const WHATSAPP_UI_STATES = [
  "DISCONNECTED", "CONNECTING", "QR_REQUIRED", "AUTHENTICATED", "CONNECTED", "ERROR",
] as const;
export type WhatsAppUiState = (typeof WHATSAPP_UI_STATES)[number];

export function mapSessionStatusToUi(status: string): WhatsAppUiState {
  switch (status) {
    case "ready": return "CONNECTED";
    case "qr_ready": return "QR_REQUIRED";
    case "authenticating": return "AUTHENTICATED";
    case "created":
    case "initializing": return "CONNECTING";
    case "failed": return "ERROR";
    case "action_required": return "ERROR";
    case "disconnected": return "DISCONNECTED";
    default: return "DISCONNECTED";
  }
}

// Error classes (§49 failure handling).
export const WHATSAPP_ERROR_CLASSES = [
  "TEMPORARY", "PERMANENT", "AUTHENTICATION", "NETWORK", "PROVIDER", "CONFIG", "RATE_LIMIT",
] as const;
export type WhatsAppErrorClass = (typeof WHATSAPP_ERROR_CLASSES)[number];

export const WHATSAPP_CATEGORIES = [
  "AUTHENTICATION", "COMPLAINT", "WORK_ORDER", "QUOTATION", "INVOICE", "PAYMENT",
  "PM", "IRMS", "NOTIFICATION", "SUPPORT", "SYSTEM",
] as const;
export type WhatsAppCategory = (typeof WHATSAPP_CATEGORIES)[number];

// Message directions/types.
export const WHATSAPP_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;
export type WhatsAppDirection = (typeof WHATSAPP_DIRECTIONS)[number];

export const WHATSAPP_MESSAGE_TYPES = [
  "text", "image", "document", "audio", "video", "location", "unknown",
] as const;
export type WhatsAppMessageType = (typeof WHATSAPP_MESSAGE_TYPES)[number];

// Conversation states (§26/§27 — human handoff, automation opt-out).
export const WHATSAPP_CONVERSATION_STATES = ["BOT", "HUMAN", "CLOSED"] as const;
export type WhatsAppConversationState = (typeof WHATSAPP_CONVERSATION_STATES)[number];

// Inbound intents (§24/§25 — controlled set; AI never executes actions).
export const WHATSAPP_INTENTS = [
  "HELP", "COMPLAINT", "SERVICE", "STATUS", "INVOICE", "QUOTATION", "PAYMENT",
  "APPOINTMENT", "CONTACT", "HUMAN",
] as const;
export type WhatsAppIntent = (typeof WHATSAPP_INTENTS)[number];

// Recipient rule (mirrors email RecipientRule §62).
export type WhatsAppRecipientRule =
  | { kind: "CUSTOMER" }
  | { kind: "RELATED_USER" }
  | { kind: "ROLE"; value: string }
  | { kind: "FIXED"; value: string };

// Attachment kinds resolved through the central PDF engine / MinIO (§31/§33).
export type WhatsAppAttachmentKind =
  | "QUOTATION_PDF" | "INVOICE_PDF" | "WO_PDF" | "INSPECTION_PDF" | "LETTER_PDF" | "PAYMENT_RECEIPT_PDF";

// OpenWA webhook delivery envelope (docs/06 §webhooks-delivery):
// { event, timestamp, sessionId, idempotencyKey, deliveryId, data }.
export type OpenWaWebhookDelivery = {
  event: string;
  timestamp?: string;
  sessionId?: string;
  idempotencyKey?: string;
  deliveryId?: string;
  data?: Record<string, unknown>;
};

// message.received data payload (docs/06 §6.6). Media over the inline cap
// arrives as { omitted: true, sizeBytes } — bytes are fetched from the
// gateway media endpoint and stored in MinIO by MOHD.HMS (§32/§33).
export type OpenWaInboundMessage = {
  id?: string;
  from?: string;
  to?: string;
  body?: string;
  type?: string;
  timestamp?: number;
  isGroup?: boolean;
  kind?: string;
  hasMedia?: boolean;
  fromMe?: boolean;
  media?: { mimetype?: string; filename?: string; data?: string; omitted?: boolean; sizeBytes?: number };
  contact?: { id?: string; number?: string; name?: string; pushName?: string };
  senderPhone?: string | null;
};
