// MOHD.HMS ENTERPRISE — WhatsApp message actions: retry | cancel (§50).
import type { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { cancelMessage, retryMessage } from "@/lib/hms/whatsapp/service";

const bodySchema = z.object({ action: z.enum(["retry", "cancel"]) });

export const POST = handler(async ({ req, user }): Promise<NextResponse> => {
  const body = await parseBody(req, bodySchema);
  const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
  if (!id) throw Errors.badRequest("Message id is required.");
  const result = body.action === "retry" ? await retryMessage(id) : await cancelMessage(id);
  if (!result.ok) throw Errors.badRequest(result.reason ?? "Action failed.");
  void audit({
    actorId: user.id, actorEmail: user.email,
    action: body.action === "retry" ? "WHATSAPP_RETRIED" : "WHATSAPP_CANCELED",
    resourceType: "WHATSAPP_MESSAGE", resourceId: id, metadata: {},
  });
  const after = await db.whatsAppMessage.findUnique({ where: { id }, select: { status: true } });
  return ok({ id, status: after?.status });
}, { permission: PERMISSIONS.whatsapp_actions });
