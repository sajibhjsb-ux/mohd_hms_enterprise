// MOHD.HMS ENTERPRISE — Automation history (§32 View history).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(
  async ({ req }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const automation = await db.emailAutomation.findUnique({ where: { id }, select: { id: true } });
    if (!automation) throw Errors.notFound("Email automation not found.");
    const { page, pageSize, skip } = listQuery(req);
    const where = { automationId: id };
    const [total, rows] = await Promise.all([
      db.emailLog.count({ where }),
      db.emailLog.findMany({
        where, orderBy: { createdAt: "desc" }, take: pageSize, skip,
        select: { id: true, toEmail: true, subject: true, status: true, attemptCount: true, scheduledAt: true, sentAt: true, lastError: true, isTest: true, createdAt: true },
      }),
    ]);
    return okList(rows, pagedMeta(page, pageSize, total));
  },
  { permission: PERMISSIONS.email_view }
);
