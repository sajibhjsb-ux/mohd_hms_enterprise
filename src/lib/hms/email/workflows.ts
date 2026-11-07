// MOHD.HMS ENTERPRISE — Email workflow registration (§16 EVENT-DRIVEN EMAILS).
// Registers the ONE email automation handler against every business event type
// that carries email automations. Runs inside the existing outbox engine — no
// second event system, no second worker (the engine provides exactly-once
// semantics, retries and dead-lettering for the events themselves).

import "server-only";
import { registerWorkflow, type WorkflowResult } from "@/lib/hms/workflows/engine";
import { runEmailAutomations } from "./service";

/** Event types with email automations (all verified to exist in the app). */
export const EMAIL_AUTOMATION_EVENTS = [
  // Complaint lifecycle
  "COMPLAINT_CREATED",
  "COMPLAINT_ASSIGNED",
  "COMPLAINT_ACCEPTED",
  "COMPLAINT_STARTED",
  "COMPLAINT_COMPLETED",
  "COMPLAINT_CONFIRMED",
  "COMPLAINT_CLOSED",
  "COMPLAINT_REOPENED",
  "COMPLAINT_CANCELLED",
  // Work orders
  "WORK_ORDER_CREATED",
  "WORK_ORDER_ACCEPTED",
  "WORK_ORDER_STARTED",
  "WORK_ORDER_ON_HOLD",
  "WORK_ORDER_SUBMITTED",
  "WORK_ORDER_CLOSED",
  "WORK_ORDER_REOPENED",
  "WORK_ORDER_COMPLETED",
  // Quotations
  "QUOTATION_SENT",
  "QUOTATION_ACCEPTED",
  "QUOTATION_EXPIRING",
  // Invoices / payments
  "INVOICE_SENT",
  "INVOICE_DUE_SOON",
  "INVOICE_OVERDUE",
  "PAYMENT_RECEIVED",
  // PM (scheduler events exist)
  "PM_REMINDER",
  "PM_OVERDUE",
  // Purchasing
  "PURCHASE_CREATED",
  // Inspections
  "INSPECTION_SUBMITTED",
  "INSPECTION_APPROVED",
  // HR letters
  "LETTER_APPROVED",
  // Inventory
  "LOW_STOCK",
] as const;

export function registerEmailWorkflows(): void {
  for (const eventType of EMAIL_AUTOMATION_EVENTS) {
    registerWorkflow(eventType, "EMAIL_AUTOMATION", async (ctx): Promise<WorkflowResult> => {
      const { queued, skipped } = await runEmailAutomations(ctx);
      if (queued > 0) return { result: "SUCCESS", detail: `${queued} email(s) queued${skipped.length ? ` (${skipped.join("; ")})` : ""}` };
      return { result: "SKIPPED", detail: skipped.join("; ") || "no emails" };
    });
  }
}
