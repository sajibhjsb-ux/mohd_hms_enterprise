// MOHD.HMS ENTERPRISE — WhatsApp templates (§37/§38): list + create.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { extractVariables } from "@/lib/hms/whatsapp/templates";
import { WHATSAPP_CATEGORIES } from "@/lib/hms/whatsapp/types";

export const GET = handler(async (): Promise<NextResponse> => {
  const rows = await db.whatsAppTemplate.findMany({
    where: { deletedAt: null },
    orderBy: { key: "asc" },
    include: { versions: { orderBy: { version: "desc" }, take: 5 } },
  });
  return okList(rows);
}, { permission: PERMISSIONS.whatsapp_view });

const createSchema = z.object({
  key: z.string().regex(/^[A-Z0-9_]{2,60}$/),
  name: z.string().min(2).max(120),
  category: z.enum(WHATSAPP_CATEGORIES).default("SYSTEM"),
  description: z.string().max(500).default(""),
  body: z.string().min(1).max(4000),
});

export const POST = handler(async ({ req, user }): Promise<NextResponse> => {
  const body = await parseBody(req, createSchema);
  const existing = await db.whatsAppTemplate.findUnique({ where: { key: body.key } });
  if (existing) throw Errors.conflict("A template with this key already exists.");
  const created = await db.whatsAppTemplate.create({
    data: {
      key: body.key, name: body.name, category: body.category,
      description: body.description, body: body.body,
      variables: JSON.stringify(extractVariables(body.body)),
      isSystem: false,
    },
  });
  void audit({
    actorId: user.id, actorEmail: user.email, action: "WHATSAPP_TEMPLATE_CREATED",
    resourceType: "WHATSAPP_TEMPLATE", resourceId: created.id, metadata: { key: body.key },
  });
  return ok(created, 201);
}, { permission: PERMISSIONS.whatsapp_templates });
