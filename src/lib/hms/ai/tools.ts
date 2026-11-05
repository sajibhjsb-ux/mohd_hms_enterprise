// MOHD.HMS ENTERPRISE — AI controlled tools (spec §12, §13, §34).
// Server-only. Read-only tools the AI may call to retrieve REAL system data.
// Each tool is RBAC-gated: a customer can only read their own records.
// The AI never executes SQL; it calls these handlers via the orchestrator.
import "server-only";
import { db } from "@/lib/db";

export type AiToolName =
  | "getCustomer"
  | "getComplaints"
  | "getWorkOrder"
  | "getEquipment"
  | "getInvoice"
  | "getQuotation"
  | "getAppointment";

export type AiToolContext = {
  /** The authenticated customer making the WhatsApp conversation (from contact → customer). */
  customerId: string | null;
  /** Staff user id when a staff member is driving (hybrid mode). */
  userId?: string | null;
};

export type AiToolResult = { ok: true; data: unknown } | { ok: false; code: string; message: string };

function customerScope(ctx: AiToolContext): { ok: true; customerId: string } | { ok: false; code: string; message: string } {
  if (!ctx.customerId) return { ok: false, code: "AI_NOT_AUTHENTICATED", message: "Customer not identified." };
  return { ok: true, customerId: ctx.customerId };
}

function toCents(n: number | null): number | null { return n ?? null; }

export async function getCustomer(ctx: AiToolContext, args: { customerId?: string }): Promise<AiToolResult> {
  const scope = customerScope(ctx);
  if (!scope.ok) return scope;
  const id = args.customerId || scope.customerId;
  if (id !== scope.customerId) return { ok: false, code: "AI_FORBIDDEN", message: "You may only read your own customer record." };
  const c = await db.customer.findUnique({ where: { id }, select: { id: true, code: true, companyName: true, contactPerson: true, email: true, phone: true, city: true, country: true, status: true, createdAt: true } });
  if (!c) return { ok: false, code: "AI_NOT_FOUND", message: "Customer not found." };
  return { ok: true, data: c };
}

export async function getComplaints(ctx: AiToolContext, args: { customerId?: string }): Promise<AiToolResult> {
  const scope = customerScope(ctx);
  if (!scope.ok) return scope;
  const id = args.customerId || scope.customerId;
  if (id !== scope.customerId) return { ok: false, code: "AI_FORBIDDEN", message: "You may only read your own complaints." };
  const rows = await db.complaint.findMany({
    where: { customerId: id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { code: true, title: true, description: true, status: true, priority: true, equipmentId: true, createdAt: true, completedAt: true },
  });
  return { ok: true, data: rows };
}

export async function getWorkOrder(ctx: AiToolContext, args: { workOrderId?: string; customerId?: string }): Promise<AiToolResult> {
  const scope = customerScope(ctx);
  if (!scope.ok) return scope;
  if (!args.workOrderId) return { ok: false, code: "AI_BAD_ARGS", message: "workOrderId is required." };
  const wo = await db.workOrder.findFirst({ where: { id: args.workOrderId, customerId: scope.customerId }, select: { code: true, title: true, description: true, status: true, priority: true, scheduledDate: true, startedAt: true, completedAt: true, customerConfirmed: true, complaintId: true } });
  if (!wo) return { ok: false, code: "AI_NOT_FOUND", message: "Work order not found." };
  return { ok: true, data: wo };
}

export async function getEquipment(ctx: AiToolContext, args: { equipmentId?: string; customerId?: string }): Promise<AiToolResult> {
  const scope = customerScope(ctx);
  if (!scope.ok) return scope;
  if (!args.equipmentId) return { ok: false, code: "AI_BAD_ARGS", message: "equipmentId is required." };
  const eq = await db.equipment.findFirst({ where: { id: args.equipmentId, customerId: scope.customerId }, select: { id: true, assetTag: true, serialNumber: true, name: true, manufacturer: true, model: true, category: true, status: true, criticality: true, installationDate: true, warrantyExpiry: true } });
  if (!eq) return { ok: false, code: "AI_NOT_FOUND", message: "Equipment not found." };
  return { ok: true, data: eq };
}

export async function getInvoice(ctx: AiToolContext, args: { invoiceId?: string; customerId?: string }): Promise<AiToolResult> {
  const scope = customerScope(ctx);
  if (!scope.ok) return scope;
  if (!args.invoiceId) return { ok: false, code: "AI_BAD_ARGS", message: "invoiceId is required." };
  const inv = await db.invoice.findFirst({ where: { id: args.invoiceId, customerId: scope.customerId }, select: { code: true, status: true, totalCents: true, paidCents: true, balanceCents: true, dueDate: true, createdAt: true } });
  if (!inv) return { ok: false, code: "AI_NOT_FOUND", message: "Invoice not found." };
  return { ok: true, data: { ...inv, total: inv.totalCents / 100, paid: inv.paidCents / 100, balance: inv.balanceCents / 100 } };
}

export async function getQuotation(ctx: AiToolContext, args: { quotationId?: string; customerId?: string }): Promise<AiToolResult> {
  const scope = customerScope(ctx);
  if (!scope.ok) return scope;
  if (!args.quotationId) return { ok: false, code: "AI_BAD_ARGS", message: "quotationId is required." };
  const q = await db.quotation.findFirst({ where: { id: args.quotationId, customerId: scope.customerId }, select: { code: true, status: true, totalCents: true, validUntil: true, createdAt: true } });
  if (!q) return { ok: false, code: "AI_NOT_FOUND", message: "Quotation not found." };
  return { ok: true, data: { ...q, total: q.totalCents / 100 } };
}

export async function getAppointment(ctx: AiToolContext, args: { customerId?: string }): Promise<AiToolResult> {
  const scope = customerScope(ctx);
  if (!scope.ok) return scope;
  const id = args.customerId || scope.customerId;
  if (id !== scope.customerId) return { ok: false, code: "AI_FORBIDDEN", message: "You may only read your own appointments." };
  // Reuse work orders as scheduled appointments proxy (no dedicated appointments table in schema).
  const rows = await db.workOrder.findMany({
    where: { customerId: scope.customerId, scheduledDate: { not: null } },
    orderBy: { scheduledDate: "asc" },
    take: 5,
    select: { code: true, title: true, status: true, scheduledDate: true },
  });
  return { ok: true, data: rows };
}

export const TOOL_HANDLERS: Record<AiToolName, (ctx: AiToolContext, args: Record<string, unknown>) => Promise<AiToolResult>> = {
  getCustomer, getComplaints, getWorkOrder, getEquipment, getInvoice, getQuotation, getAppointment,
};

export async function executeTool(ctx: AiToolContext, toolName: AiToolName, args: Record<string, unknown>): Promise<AiToolResult> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) return { ok: false, code: "AI_UNKNOWN_TOOL", message: `Unknown tool ${toolName}.` };
  try {
    return await handler(ctx, args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, code: "AI_TOOL_ERROR", message: msg.slice(0, 300) };
  }
}
