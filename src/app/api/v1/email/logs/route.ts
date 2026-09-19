// MOHD.HMS ENTERPRISE — Email logs API (§30 EMAIL LOG PAGE).
// Filters: status, category, recipient, template, related module, date range,
// free-text search. The log is the authoritative email history (§20).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, listQuery, pagedMeta } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(
  async ({ req }) => {
    const { page, pageSize, skip, search } = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const status = (sp.get("status") ?? "").trim();
    const category = (sp.get("category") ?? "").trim();
    const recipient = (sp.get("recipient") ?? "").trim();
    const templateKey = (sp.get("template") ?? "").trim();
    const relatedType = (sp.get("relatedType") ?? "").trim();
    const automationId = (sp.get("automationId") ?? "").trim();
    const from = (sp.get("from") ?? "").trim();
    const to = (sp.get("to") ?? "").trim();

    const where = {
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
      ...(recipient ? { toEmail: { contains: recipient } } : {}),
      ...(templateKey ? { templateKey } : {}),
      ...(relatedType ? { relatedType } : {}),
      ...(automationId ? { automationId } : {}),
      ...((from || to)
        ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } }
        : {}),
      ...(search
        ? {
            OR: [
              { toEmail: { contains: search } },
              { subject: { contains: search } },
              { templateKey: { contains: search } },
              { relatedId: { contains: search } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      db.emailLog.count({ where }),
      db.emailLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pageSize,
        skip,
        select: {
          id: true, status: true, toEmail: true, subject: true, category: true, templateKey: true,
          templateVersion: true, relatedType: true, relatedId: true, attemptCount: true, maxAttempts: true,
          scheduledAt: true, sentAt: true, failedAt: true, lastError: true, errorClass: true,
          messageId: true, isTest: true, createdAt: true, automation: { select: { name: true } },
        },
      }),
    ]);
    return okList(rows.map((r) => ({ ...r, hasBody: false })), pagedMeta(page, pageSize, total));
  },
  { permission: PERMISSIONS.email_view }
);
