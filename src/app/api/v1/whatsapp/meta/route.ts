// MOHD.HMS ENTERPRISE — WhatsApp admin meta (vocabularies for the admin UI).
import type { NextResponse } from "next/server";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { WHATSAPP_AUTOMATION_EVENTS } from "@/lib/hms/whatsapp/automations";
import { WHATSAPP_CATEGORIES, WHATSAPP_STATUSES, WHATSAPP_UI_STATES, WHATSAPP_CONVERSATION_STATES } from "@/lib/hms/whatsapp/types";
import { TEMPLATE_CATALOG } from "@/lib/hms/whatsapp/templates";

export const GET = handler(async (): Promise<NextResponse> => {
  return ok({
    statuses: WHATSAPP_STATUSES,
    uiStates: WHATSAPP_UI_STATES,
    categories: WHATSAPP_CATEGORIES,
    conversationStates: WHATSAPP_CONVERSATION_STATES,
    events: WHATSAPP_AUTOMATION_EVENTS,
    templateKeys: TEMPLATE_CATALOG.map((t) => ({ key: t.key, name: t.name, variables: t.variables })),
    recipientKinds: ["CUSTOMER", "RELATED_USER", "ROLE", "FIXED"],
    attachmentKinds: ["QUOTATION_PDF", "INVOICE_PDF", "WO_PDF", "INSPECTION_PDF", "LETTER_PDF", "PAYMENT_RECEIPT_PDF"],
  });
}, { permission: PERMISSIONS.whatsapp_view });
