// MOHD.HMS ENTERPRISE — Email log detail (§31 EMAIL DETAIL PAGE).
// The rendered body (when still within the retention window) is returned
// sanitized — it renders in the admin UI inside a sandboxed iframe only.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { sanitizeEmailHtml } from "@/lib/hms/email/layout";

export const GET = handler(
  async ({ req }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const log = await db.emailLog.findUnique({
      where: { id },
      include: { automation: { select: { id: true, name: true, eventType: true } } },
    });
    if (!log) throw Errors.notFound("Email log entry not found.");

    return ok({
      id: log.id,
      status: log.status,
      toEmail: log.toEmail,
      toUserId: log.toUserId,
      cc: log.cc,
      bcc: log.bcc,
      fromName: log.fromName,
      fromEmail: log.fromEmail,
      replyTo: log.replyTo,
      subject: log.subject,
      category: log.category,
      templateKey: log.templateKey,
      templateVersion: log.templateVersion,
      automation: log.automation,
      relatedType: log.relatedType,
      relatedId: log.relatedId,
      attachmentRefs: safeParse(log.attachmentRefs),
      attemptCount: log.attemptCount,
      maxAttempts: log.maxAttempts,
      scheduledAt: log.scheduledAt,
      sentAt: log.sentAt,
      failedAt: log.failedAt,
      lastError: log.lastError,
      errorClass: log.errorClass,
      messageId: log.messageId,
      providerResponse: log.providerResponse,
      isTest: log.isTest,
      createdAt: log.createdAt,
      updatedAt: log.updatedAt,
      // Body retention (§56): pruned bodies come back as null and the UI says so.
      bodyHtml: log.bodyHtml ? sanitizeEmailHtml(log.bodyHtml) : null,
      bodyPruned: !log.bodyHtml && Boolean(log.bodyPrunedAt),
    });
  },
  { permission: PERMISSIONS.email_view }
);

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json || "[]");
  } catch {
    return [];
  }
}
