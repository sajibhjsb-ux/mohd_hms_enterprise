// MOHD.HMS ENTERPRISE — AI action proposals + confirmation (spec §9, §22).
// Server-only. Low-risk actions (create complaint) are PROPOSED first; the
// customer must confirm before anything is written. Backend confirms the result;
// the AI never invents complaint numbers. Human-only operations are never
// proposed here (finance, approvals, closing work orders, etc.).
import "server-only";
import { db } from "@/lib/db";
import { nextNumber } from "@/lib/hms/services";
import { audit, notifyRole } from "@/lib/hms/services";
import { appendMessage, setConversationState, updateConversationIntent } from "./conversation";
import type { AiAction } from "@prisma/client";

export type ActionType = "CREATE_COMPLAINT";

export type ProposedCreateComplaint = {
  customerId: string;
  title: string;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  equipmentId?: string | null;
  workCatalogue?: string;
  catalogueIssue?: string;
};

export async function proposeCreateComplaint({
  conversationId,
  chatId,
  customerId,
  payload,
}: {
  conversationId: string;
  chatId: string;
  customerId: string;
  payload: ProposedCreateComplaint;
}): Promise<AiAction> {
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { id: true, contactPerson: true } });
  if (!customer) throw new Error("Customer not found.");
  return db.aiAction.create({
    data: {
      conversationId,
      actionType: "CREATE_COMPLAINT",
      status: "PROPOSED",
      payload: JSON.stringify({ ...payload, contactPerson: customer.contactPerson }),
    },
  });
}

export async function getProposedAction(conversationId: string): Promise<AiAction | null> {
  return db.aiAction.findFirst({
    where: { conversationId, status: "PROPOSED" },
    orderBy: { createdAt: "desc" },
  });
}

export async function rejectAction(actionId: string, byUserId: string): Promise<AiAction | null> {
  const action = await db.aiAction.findUnique({ where: { id: actionId } });
  if (!action || action.status !== "PROPOSED") return null;
  return db.aiAction.update({
    where: { id: actionId },
    data: { status: "REJECTED", updatedAt: new Date() },
  });
}

/** Customer confirms a proposed complaint. Creates the real complaint row and returns its code. */
export async function confirmCreateComplaint(actionId: string, customerId: string): Promise<{ ok: true; complaintCode: string } | { ok: false; code: string; message: string }> {
  const action = await db.aiAction.findUnique({ where: { id: actionId } });
  if (!action || action.status !== "PROPOSED") {
    return { ok: false, code: "AI_ACTION_NOT_FOUND", message: "No pending action to confirm." };
  }
  const payload = JSON.parse(action.payload ?? "{}") as ProposedCreateComplaint;
  if (payload.customerId !== customerId) {
    return { ok: false, code: "AI_FORBIDDEN", message: "You may only confirm your own actions." };
  }

  const systemUser = await db.user.findFirst({ where: { role: "SUPER_ADMIN", status: "ACTIVE" }, select: { id: true } });
  const actorId = systemUser?.id ?? "";

  let code: string;
  try {
    code = await nextNumber("CPT");
  } catch {
    return { ok: false, code: "AI_NUMBER_FAILED", message: "Could not generate a complaint number right now." };
  }

  const created = await db.complaint.create({
    data: {
      code,
      customerId,
      title: `WhatsApp: ${payload.title}`,
      description: payload.description,
      priority: payload.priority,
      status: "NEW",
      createdById: actorId,
      equipmentId: payload.equipmentId ?? undefined,
      workCatalogue: payload.workCatalogue ?? "",
      catalogueIssue: payload.catalogueIssue ?? "",
      statusHistory: {
        create: { fromStatus: "NEW", toStatus: "NEW", changedById: actorId, note: "Complaint created via WhatsApp AI (customer-confirmed)" },
      },
    },
    select: { id: true, code: true },
  });

  await db.aiAction.update({
    where: { id: actionId },
    data: {
      status: "EXECUTED",
      result: JSON.stringify({ complaintId: created.id, complaintCode: created.code }),
      updatedAt: new Date(),
    },
  });

  try {
    await audit({ action: "WHATSAPP_AI_COMPLAINT_CREATED", resourceType: "COMPLAINT", resourceId: created.id, metadata: { code, chatId: action.conversationId, customerId, channel: "WHATSAPP_AI" } }).catch(() => undefined);
    await notifyRole("SUPERVISOR", { title: "New complaint (WhatsApp AI)", message: `New complaint ${code} created via WhatsApp AI.`, type: "INFO", resourceType: "COMPLAINT", resourceId: created.id }).catch(() => undefined);
    await notifyRole("ADMIN", { title: "New complaint (WhatsApp AI)", message: `New complaint ${code} created via WhatsApp AI.`, type: "INFO", resourceType: "COMPLAINT", resourceId: created.id }).catch(() => undefined);
  } catch { /* notifications must not fail the confirmation */ }

  return { ok: true, complaintCode: created.code };
}

/** Staff approves a proposed low-risk action and executes it (spec §22). */
export async function approveAction(actionId: string, byUserId: string): Promise<{ ok: true; complaintCode?: string } | { ok: false; code: string; message: string } | null> {
  const action = await db.aiAction.findUnique({ where: { id: actionId } });
  if (!action || action.status !== "PROPOSED") return null;
  if (action.actionType !== "CREATE_COMPLAINT") {
    return { ok: false, code: "AI_ACTION_TYPE", message: "Only complaint creation can be auto-approved." };
  }
  const payload = JSON.parse(action.payload ?? "{}") as ProposedCreateComplaint;
  const actorId = byUserId;
  let code: string;
  try { code = await nextNumber("CPT"); } catch { return { ok: false, code: "AI_NUMBER_FAILED", message: "Could not generate a complaint number right now." }; }
  const created = await db.complaint.create({
    data: {
      code, customerId: payload.customerId,
      title: `WhatsApp: ${payload.title}`, description: payload.description, priority: payload.priority,
      status: "NEW", createdById: actorId,
      equipmentId: payload.equipmentId ?? undefined,
      workCatalogue: payload.workCatalogue ?? "", catalogueIssue: payload.catalogueIssue ?? "",
      statusHistory: { create: { fromStatus: "NEW", toStatus: "NEW", changedById: actorId, note: "Complaint created via WhatsApp AI (staff-approved)" } },
    },
    select: { id: true, code: true },
  });
  await db.aiAction.update({
    where: { id: actionId },
    data: { status: "EXECUTED", approvedById: byUserId, approvedAt: new Date(),
      result: JSON.stringify({ complaintId: created.id, complaintCode: created.code }), updatedAt: new Date() },
  });
  await audit({ action: "WHATSAPP_AI_COMPLAINT_APPROVED", resourceType: "COMPLAINT", resourceId: created.id, metadata: { code, chatId: action.conversationId, approvedById: byUserId } }).catch(() => undefined);
  return { ok: true, complaintCode: created.code };
}

export async function closeProposedAction(conversationId: string): Promise<void> {
  await db.aiAction.updateMany({ where: { conversationId, status: "PROPOSED" }, data: { status: "REJECTED", updatedAt: new Date() } });
}
