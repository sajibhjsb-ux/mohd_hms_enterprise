import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, listQuery } from "@/lib/hms/api";


const upsertSchema = z.object({
  formKey: z.string().min(1).max(200),
  data: z.string().max(100_000),
});

/** Server-side draft backup (unsaved form protection). */
export const POST = handler(async ({ req, user }) => {
  const { formKey, data } = await parseBody(req, upsertSchema);
  // Never store credentials in drafts
  if (/"password"\s*:/i.test(data) || /"token"\s*:/i.test(data)) return ok({ saved: false });
  await db.draft.upsert({
    where: { userId_formKey: { userId: user.id, formKey } },
    update: { data },
    create: { userId: user.id, formKey, data },
  });
  return ok({ saved: true });
});

export const GET = handler(async ({ req, user }) => {
  const { search } = listQuery(req);
  const where = search
    ? { AND: [{ userId: user.id }, { formKey: { contains: search } }] }
    : { userId: user.id };
  const drafts = await db.draft.findMany({ where, orderBy: { updatedAt: "desc" } });
  return ok(drafts);
});

export const DELETE = handler(async ({ req, user }) => {
  const formKey = new URL(req.url).searchParams.get("formKey") ?? "";
  if (!formKey) return ok({ deleted: 0 });
  const deleted = await db.draft.deleteMany({ where: { userId: user.id, formKey } });
  return ok({ deleted: deleted.count });
});
