// MOHD.HMS ENTERPRISE — Audit log API.
// GET /api/v1/audit-logs (audit.read)
// Filters: action (contains), actorEmail (contains), search (action/actor/resource),
// from/to (createdAt range, YYYY-MM-DD). Paginated, newest first.
// `metadata` is parsed JSON and returned as an object when possible.

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, okList, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeParseMetadata(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw; // not JSON — surface the raw string so nothing is silently lost
  }
}

export const GET = handler(
  async ({ req }) => {
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const action = (sp.get("action") ?? "").trim();
    const actorEmail = (sp.get("actorEmail") ?? "").trim();
    const resourceType = (sp.get("resourceType") ?? "").trim();
    const resourceId = (sp.get("resourceId") ?? "").trim();
    const fromRaw = sp.get("from");
    const toRaw = sp.get("to");

    if (fromRaw && !DATE_RE.test(fromRaw)) throw Errors.badRequest("`from` must be a YYYY-MM-DD date.");
    if (toRaw && !DATE_RE.test(toRaw)) throw Errors.badRequest("`to` must be a YYYY-MM-DD date.");

    const where: Prisma.AuditLogWhereInput = {};
    if (action) where.action = { contains: action };
    if (actorEmail) where.actorEmail = { contains: actorEmail };
    if (resourceType) where.resourceType = resourceType;
    if (resourceId) where.resourceId = resourceId;
    if (q.search) {
      where.OR = ["action", "actorEmail", "resourceType", "resourceId"].map((field) => ({
        [field]: { contains: q.search },
      }));
    }
    const createdAt: Prisma.DateTimeFilter = {};
    if (fromRaw) createdAt.gte = new Date(`${fromRaw}T00:00:00.000Z`);
    if (toRaw) createdAt.lte = new Date(`${toRaw}T23:59:59.999Z`);
    if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;

    const [total, logs] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        include: { actor: { select: { name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip: q.skip,
        take: q.take,
      }),
    ]);

    const items = logs.map((log) => ({
      id: log.id,
      actorId: log.actorId,
      actorName: log.actor?.name ?? null,
      actorEmail: log.actorEmail || log.actor?.email || "",
      action: log.action,
      resourceType: log.resourceType,
      resourceId: log.resourceId,
      metadata: safeParseMetadata(log.metadata),
      ip: log.ip,
      createdAt: log.createdAt.toISOString(),
    }));

    return okList(items, pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.audit_read }
);
