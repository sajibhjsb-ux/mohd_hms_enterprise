// MOHD.HMS ENTERPRISE — WhatsApp AI action approval (§22).
// POST /api/v1/whatsapp/ai/action/[id] — body { decision: "approve"|"reject", comment? }.
// RBAC whatsapp_send.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { approveAction, rejectAction } from "@/lib/hms/ai/action";

function idFromUrl(req: Request): string {
  return new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
}

const bodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(500).optional(),
});

export const POST = handler(async ({ req, user }): Promise<NextResponse> => {
  const id = idFromUrl(req);
  const action = await db.aiAction.findUnique({ where: { id }, select: { id: true, status: true, conversationId: true } });
  if (!action) throw Errors.notFound("Action not found.");
  if (action.status !== "PROPOSED") throw Errors.badRequest("Action is no longer pending.");
  const body = await parseBody(req, bodySchema);

  if (body.decision === "approve") {
    const result = await approveAction(id, user.id);
    if (!result) throw Errors.badRequest("Could not approve the action.");
    if (!result.ok) throw Errors.badRequest(result.message);
    await audit({
      actorId: user.id, actorEmail: user.email, action: "WHATSAPP_AI_ACTION_APPROVED",
      resourceType: "AI_ACTION", resourceId: id, metadata: { decision: "approve", comment: body.comment },
    }).catch(() => undefined);
    return ok({ ok: true, complaintCode: result.complaintCode });
  }

  const updated = await rejectAction(id, user.id);
  if (!updated) throw Errors.badRequest("Could not reject the action.");
  await audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_AI_ACTION_REJECTED",
    resourceType: "AI_ACTION", resourceId: id, metadata: { decision: "reject", comment: body.comment },
  }).catch(() => undefined);
  return ok({ ok: true });
}, { permission: PERMISSIONS.whatsapp_send });
