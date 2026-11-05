// MOHD.HMS ENTERPRISE — WhatsApp AI human handover (§15).
// POST /api/v1/whatsapp/ai/conversation/[id]/handover — RBAC whatsapp_send.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { triggerHandover } from "@/lib/hms/ai/handover";

function idFromUrl(req: Request): string {
  return new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
}

const bodySchema = z.object({
  reason: z.enum(["HUMAN_REQUEST", "AI_FAILURE", "MANUAL", "ESCALATION"]).optional(),
  assignedToId: z.string().optional(),
});

export const POST = handler(async ({ req, user }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const conv = await db.aiConversation.findUnique({ where: { id }, select: { id: true, chatId: true } });
  if (!conv) throw Errors.notFound("Conversation not found.");
  const body = await parseBody(req, bodySchema);
  const hv = await triggerHandover({
    conversationId: id, chatId: conv.chatId,
    reason: body.reason ?? "MANUAL", assignedToId: body.assignedToId ?? null,
  });
  if ("ok" in hv) throw Errors.badRequest(hv.message);
  await audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_AI_HANDOVER_TRIGGERED",
    resourceType: "AI_CONVERSATION", resourceId: id, metadata: { chatId: conv.chatId, reason: body.reason ?? "MANUAL" },
  }).catch(() => undefined);
  return ok({ ok: true, handoverId: hv.handoverId });
}, { permission: PERMISSIONS.whatsapp_send });
