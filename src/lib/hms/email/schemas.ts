// MOHD.HMS ENTERPRISE — Email automation API schemas (shared zod definitions).

import "server-only";
import { z } from "zod";

export const recipientRuleSchema = z.object({
  kind: z.enum(["CUSTOMER", "RELATED_USER", "ROLE", "MODULE_MAILBOX", "FIXED"]),
  value: z.string().max(254).optional(),
});

export const conditionSchema = z.object({
  field: z.string().regex(/^[A-Za-z0-9_.]{1,60}$/),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "exists"]),
  value: z.union([z.string().max(300), z.number(), z.boolean()]).optional(),
});

export const attachmentSchema = z.object({
  kind: z.enum(["INVOICE_PDF", "QUOTATION_PDF", "WO_PDF", "INSPECTION_PDF", "LETTER_PDF", "PAYMENT_RECEIPT_PDF"]),
});

export const automationPatchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  templateKey: z.string().max(60).optional(),
  recipientRule: recipientRuleSchema.optional(),
  senderName: z.string().max(120).optional(),
  senderEmail: z.string().max(254).optional(),
  replyTo: z.string().max(254).optional(),
  delayMinutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
  conditions: z.array(conditionSchema).max(10).optional(),
  attachments: z.array(attachmentSchema).max(3).optional(),
  enabled: z.boolean().optional(),
  critical: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  dedupeHours: z.number().int().min(0).max(720).optional(),
});
