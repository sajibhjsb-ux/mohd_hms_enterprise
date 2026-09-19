// MOHD.HMS ENTERPRISE — Email templates API (§8/§9/§10/§11).
// GET  — list (includes per-template variables + latest version)
// POST — create a new (non-system) template; validated before it can activate.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { validateTemplate } from "@/lib/hms/email/render";
import { EMAIL_CATEGORIES } from "@/lib/hms/email/types";

export const GET = handler(
  async ({ req }) => {
    const url = new URL(req.url);
    const category = url.searchParams.get("category") ?? "";
    const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
    const includeDeleted = url.searchParams.get("includeDeleted") === "1";

    const rows = await db.emailTemplate.findMany({
      where: {
        ...(includeDeleted ? {} : { deletedAt: null }),
        ...(category ? { category } : {}),
        ...(search
          ? {
              OR: [
                { key: { contains: search } },
                { name: { contains: search } },
                { description: { contains: search } },
                { subject: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: { versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, createdAt: true, editedBy: true } } },
    });
    return ok(rows.map((t) => ({ ...t, variables: safeVars(t.variables), latestVersion: t.versions[0] ?? null, versions: undefined })));
  },
  { permission: PERMISSIONS.email_view }
);

const createSchema = z.object({
  key: z.string().regex(/^[A-Z0-9_]{3,60}$/, "Key must be UPPER_SNAKE_CASE (3–60 chars)."),
  name: z.string().min(2).max(120),
  category: z.enum(EMAIL_CATEGORIES),
  description: z.string().max(500).default(""),
  subject: z.string().min(1).max(300),
  bodyHtml: z.string().min(1).max(200_000),
  variables: z.array(z.string().regex(/^[A-Z0-9_]{2,60}$/)).max(100).default([]),
});

function safeVars(json: string): string[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    if (await db.emailTemplate.findUnique({ where: { key: body.key } })) {
      throw Errors.conflict(`A template with key ${body.key} already exists.`);
    }
    const errors = validateTemplate({ subject: body.subject, bodyHtml: body.bodyHtml, allowedVariables: body.variables });
    if (errors.length) throw Errors.badRequest(`Template validation failed: ${errors.join(" ")}`);

    const created = await db.emailTemplate.create({
      data: {
        key: body.key, name: body.name, category: body.category, description: body.description,
        subject: body.subject, bodyHtml: body.bodyHtml, variables: JSON.stringify(body.variables),
        isSystem: false, isActive: true, version: 1,
        versions: { create: { version: 1, subject: body.subject, bodyHtml: body.bodyHtml, editedBy: user.email } },
      },
    });
    await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_TEMPLATE_CREATED", resourceType: "EMAIL_TEMPLATE", resourceId: created.id, metadata: { key: created.key, category: created.category } });
    return ok({ ...created, variables: body.variables }, 201);
  },
  { permission: PERMISSIONS.email_templates }
);
