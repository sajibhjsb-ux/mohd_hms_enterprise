// MOHD.HMS ENTERPRISE — Template version history (§42).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

export const GET = handler(
  async ({ req }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const template = await db.emailTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!template) throw Errors.notFound("Email template not found.");
    const versions = await db.emailTemplateVersion.findMany({ where: { templateId: id }, orderBy: { version: "desc" } });
    return ok(versions);
  },
  { permission: PERMISSIONS.email_view }
);
