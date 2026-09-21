// MOHD.HMS ENTERPRISE — Email client contact groups (shared distribution
// lists for the compose UI).
//
// GET  /api/v1/email/client/groups   — list (members parsed server-side)
// POST /api/v1/email/client/groups   — create { name, color, members }
//
// Members are validated email references only — never raw keys or freeform
// data injected into the send path.

import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { mailGroupSchema, normalizeGroupMembers } from "@/lib/hms/email/client";

function normalizeOrThrow(members: { name: string; email: string }[]) {
  const res = normalizeGroupMembers(members);
  if (!res.ok) throw Errors.badRequest(res.error);
  return res.list;
}

export const GET = handler(
  async () => {
    const groups = await db.mailContactGroup.findMany({ orderBy: { name: "asc" } });
    return ok(
      groups.map((g) => ({ id: g.id, name: g.name, color: g.color, members: JSON.parse(g.members || "[]") }))
    );
  },
  { permission: PERMISSIONS.email_client }
);

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, mailGroupSchema);
    const members = normalizeOrThrow(body.members);
    const name = body.name.replace(/[\r\n\t]+/g, " ").trim();
    const exists = await db.mailContactGroup.findUnique({ where: { name }, select: { id: true } });
    if (exists) throw Errors.conflict("A group with this name already exists.");
    const group = await db.mailContactGroup.create({
      data: { name, color: body.color, members: JSON.stringify(members), createdBy: user.id },
    });
    return ok({ id: group.id, name: group.name, color: group.color, members });
  },
  { permission: PERMISSIONS.email_client }
);
