// MOHD.HMS ENTERPRISE — WhatsApp message log list (§28/§55). Permission-
// gated, paginated; safe fields only (media bytes always stay in MinIO).
import type { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, okList, pagedMeta, listQuery } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(async ({ req }): Promise<NextResponse> => {
  const q = listQuery(req);
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "";
  const direction = url.searchParams.get("direction") ?? "";
  const chatId = url.searchParams.get("chatId") ?? "";
  const where = {
    ...(status ? { status } : {}),
    ...(direction ? { direction } : {}),
    ...(chatId ? { chatId } : {}),
    ...(q.search ? { OR: [{ body: { contains: q.search } }, { chatId: { contains: q.search } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.whatsAppMessage.findMany({
      where,
      orderBy: { createdAt: q.dir === "asc" ? "asc" : "desc" },
      skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      select: {
        id: true, chatId: true, direction: true, status: true, type: true, body: true,
        templateKey: true, templateVersion: true, relatedType: true, relatedId: true,
        attemptCount: true, maxAttempts: true, lastError: true, errorClass: true,
        isTest: true, fromMe: true, mediaMimetype: true, mediaFilename: true,
        sentAt: true, createdAt: true, providerMessageId: true,
        contact: { select: { waName: true, phone: true, customerId: true, kind: true } },
        conversation: { select: { state: true } },
      },
    }),
    db.whatsAppMessage.count({ where }),
  ]);
  return okList(rows.map((r) => ({ ...r, body: r.body.length > 160 ? `${r.body.slice(0, 157)}…` : r.body })), pagedMeta(q.page, q.pageSize, total));
}, { permission: PERMISSIONS.whatsapp_view });
