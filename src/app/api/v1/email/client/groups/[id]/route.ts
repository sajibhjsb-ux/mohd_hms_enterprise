// MOHD.HMS ENTERPRISE — Email client contact group item.
// PATCH  /api/v1/email/client/groups/{id} — rename / recolor / edit members
// DELETE /api/v1/email/client/groups/{id} — remove

import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { mailGroupSchema, normalizeGroupMembers } from "@/lib/hms/email/groups";

function idFromPath(url: string): string {
  // /api/v1/email/client/groups/{id}
  return new URL(url).pathname.split("/").filter(Boolean)[5] ?? "";
}

export const PATCH = handler(
  async ({ req, user }) => {
    const id = idFromPath(req.url);
    const body = await parseBody(req, mailGroupSchema);
    const members = normalizeGroupMembers(body.members);
    const name = body.name.replace(/[\r\n\t]+/g, " ").trim();

    const group = await db.mailContactGroup.findUnique({ where: { id }, select: { id: true } });
    if (!group) throw Errors.notFound("Group not found.");
    const clash = await db.mailContactGroup.findUnique({ where: { name }, select: { id: true } });
    if (clash && clash.id !== id) throw Errors.conflict("A group with this name already exists.");

    await db.mailContactGroup.update({
      where: { id },
      data: { name, color: body.color, members: JSON.stringify(members), createdBy: user.id },
    });
    return ok({ id, name, color: body.color, members });
  },
  { permission: PERMISSIONS.email_client }
);

export const DELETE = handler(
  async ({ req }) => {
    const id = idFromPath(req.url);
    const group = await db.mailContactGroup.findUnique({ where: { id }, select: { id: true } });
    if (!group) throw Errors.notFound("Group not found.");
    await db.mailContactGroup.delete({ where: { id } });
    return ok({ id, deleted: true });
  },
  { permission: PERMISSIONS.email_client }
);
