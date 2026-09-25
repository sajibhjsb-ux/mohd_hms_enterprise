// MOHD.HMS ENTERPRISE — Document Templates API (Settings → Templates).
//
//   GET  /api/v1/templates            → list (filters: type/status/search)
//   POST /api/v1/templates            → create DRAFT template (+ version 1)
//
// The registry of templateable types/blocks/variables lives in
// template-meta.ts and is shared verbatim with the editor UI — one source.

import { z } from "zod";
import { handler, okList, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { createTemplate, listTemplates } from "@/lib/hms/templates/service";

const listSchema = z.object({
  type: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
});

export const GET = handler(
  async ({ req }) => {
    const url = new URL(req.url);
    const filter = listSchema.parse({
      type: url.searchParams.get("type") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
    });
    const items = await listTemplates(filter);
    return okList(items);
  },
  { permission: PERMISSIONS.templates_read }
);

const createSchema = z.object({
  templateType: z.string().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  layout: z.unknown().optional(),
  style: z.unknown().optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);
    const created = await createTemplate(body, { id: user.id, email: user.email });
    return ok(created, 201);
  },
  { permission: PERMISSIONS.templates_manage }
);
