// MOHD.HMS ENTERPRISE — Workflow engine types.
// Central event vocabulary (§3 EVENT-DRIVEN ARCHITECTURE). Business services emit
// these after their authoritative database write; the outbox worker (§5) executes
// the registered workflow actions exactly once, with retry (§7) and dead-lettering
// (§8). NEVER emit business events from frontend code.

import "server-only";
import type { Prisma } from "@prisma/client";

export const EVENT_TYPES = {
  // Complaint lifecycle (§10)
  COMPLAINT_CREATED: "COMPLAINT_CREATED",
  COMPLAINT_ASSIGNED: "COMPLAINT_ASSIGNED",
  COMPLAINT_ACCEPTED: "COMPLAINT_ACCEPTED",
  COMPLAINT_STARTED: "COMPLAINT_STARTED",
  COMPLAINT_COMPLETED: "COMPLAINT_COMPLETED",
  COMPLAINT_CONFIRMED: "COMPLAINT_CONFIRMED",
  COMPLAINT_CLOSED: "COMPLAINT_CLOSED",
  // Work orders (§13/§14)
  COMPLAINT_ACCEPTANCE_AUTO_WO: "COMPLAINT_ACCEPTANCE_AUTO_WO",
  WORK_ORDER_COMPLETED: "WORK_ORDER_COMPLETED",
  // Inventory (§16/§17)
  LOW_STOCK: "LOW_STOCK",
  // Purchasing (§18/§19)
  PURCHASE_RECEIVED: "PURCHASE_RECEIVED",
  // PM automation (§20/§21) — raised by the scheduler
  PM_DUE: "PM_DUE",
  PM_REMINDER: "PM_REMINDER",
  PM_OVERDUE: "PM_OVERDUE",
  // Quotations (§24)
  QUOTATION_SENT: "QUOTATION_SENT",
  QUOTATION_ACCEPTED: "QUOTATION_ACCEPTED",
  QUOTATION_EXPIRING: "QUOTATION_EXPIRING",
  // Invoices / payments (§26/§27)
  INVOICE_SENT: "INVOICE_SENT",
  INVOICE_OVERDUE: "INVOICE_OVERDUE",
  INVOICE_DUE_SOON: "INVOICE_DUE_SOON",
  PAYMENT_RECEIVED: "PAYMENT_RECEIVED",
  // Inspections (§70)
  INSPECTION_COMPLETED: "INSPECTION_COMPLETED",
  INSPECTION_SUBMITTED: "INSPECTION_SUBMITTED",
  INSPECTION_REVIEWED: "INSPECTION_REVIEWED",
  INSPECTION_APPROVED: "INSPECTION_APPROVED",
  INSPECTION_REJECTED: "INSPECTION_REJECTED",
  INSPECTION_ARCHIVED: "INSPECTION_ARCHIVED",
  // Escalation / SLA / overdue — raised by the scheduler (§22/§34/§59/§62)
  ESCALATE_COMPLAINT_NOT_ACCEPTED: "ESCALATE_COMPLAINT_NOT_ACCEPTED",
  SLA_BREACH_COMPLAINT: "SLA_BREACH_COMPLAINT",
  WO_OVERDUE: "WO_OVERDUE",
  // Email queue (§30) — centralized EmailService input
  EMAIL_SEND: "EMAIL_SEND",
  // HR letters (email automations on the letter workflow)
  LETTER_APPROVED: "LETTER_APPROVED",
  // ── Centralized checklist engine (AI checklist spec §36/§69) ──
  // Business events raised by the checklist engine's API routes; the auto
  // generation handlers live in handlers.ts and react to COMPLAINT_CREATED /
  // WORK_ORDER_CREATED (both setting-gated — §23 no uncontrolled AI content).
  CHECKLIST_GENERATED: "CHECKLIST_GENERATED",
  CHECKLIST_UPDATED: "CHECKLIST_UPDATED",
  CHECKLIST_COMPLETED: "CHECKLIST_COMPLETED",
  // ─── Realtime broadcast events (FULL REALTIME UPDATE SYSTEM) ───
  // These extend the same outbox vocabulary so every business mutation that
  // should reach connected portals is persisted in the ONE authoritative
  // DomainEvent outbox and dispatched to authorized sockets by the realtime
  // dispatcher. NO frontend code may emit these.
  NOTIFICATION_CREATED: "NOTIFICATION_CREATED",
  COMPLAINT_UPDATED: "COMPLAINT_UPDATED",
  WORK_ORDER_CREATED: "WORK_ORDER_CREATED",
  WORK_ORDER_UPDATED: "WORK_ORDER_UPDATED",
  QUOTATION_CREATED: "QUOTATION_CREATED",
  QUOTATION_UPDATED: "QUOTATION_UPDATED",
  INVOICE_CREATED: "INVOICE_CREATED",
  INVOICE_UPDATED: "INVOICE_UPDATED",
  PURCHASE_CREATED: "PURCHASE_CREATED",
  PURCHASE_UPDATED: "PURCHASE_UPDATED",
  INVENTORY_ADJUSTED: "INVENTORY_ADJUSTED",
  INVENTORY_ITEM_UPDATED: "INVENTORY_ITEM_UPDATED",
  SUPPLIER_UPDATED: "SUPPLIER_UPDATED",
  EQUIPMENT_UPDATED: "EQUIPMENT_UPDATED",
  CUSTOMER_UPDATED: "CUSTOMER_UPDATED",
  USER_UPDATED: "USER_UPDATED",
  HR_LEAVE_UPDATED: "HR_LEAVE_UPDATED",
  EMPLOYEE_UPDATED: "EMPLOYEE_UPDATED",
  // Payroll (under HR) — run lifecycle + payslip publication + overtime approvals
  PAYROLL_RUN_UPDATED: "PAYROLL_RUN_UPDATED",
  PAYSLIP_PUBLISHED: "PAYSLIP_PUBLISHED",
  HR_OVERTIME_UPDATED: "HR_OVERTIME_UPDATED",
  PM_PLAN_UPDATED: "PM_PLAN_UPDATED",
  PM_TASK_UPDATED: "PM_TASK_UPDATED",
  IRMS_PROJECT_UPDATED: "IRMS_PROJECT_UPDATED",
  IRMS_REPORT_UPDATED: "IRMS_REPORT_UPDATED",
  IRMS_PHOTOS_UPDATED: "IRMS_PHOTOS_UPDATED",
  VEHICLE_UPDATED: "VEHICLE_UPDATED",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export type TxClient = Prisma.TransactionClient;

export type EmitInput = {
  type: EventType | string;
  resourceType?: string;
  resourceId?: string;
  payload?: Record<string, unknown>;
  /** USER = human-triggered action; SYSTEM = scheduler/automation (§39). */
  actorType?: "USER" | "SYSTEM";
  actorId?: string | null;
  requestId?: string;
  /**
   * Transactional outbox (§4/§5): pass the interactive transaction client so the
   * event row commits together with the business data — database updated but
   * automation lost (or the inverse) becomes impossible.
   */
  tx?: TxClient;
};
