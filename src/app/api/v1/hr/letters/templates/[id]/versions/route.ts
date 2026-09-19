// MOHD.HMS ENTERPRISE — Template version history (§27).
//
//   GET /api/v1/hr/letters/templates/{id}/versions — immutable version list

import { db } from "@/lib/db";
import { handler, okList, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { versionToDto } from "@/lib/hms/letters/server";

export const GET = handler(
  async ({ req }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[5] ?? "";
    const exists = await db.letterTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw Errors.notFound("Letter template not found.");
    const versions = await db.letterTemplateVersion.findMany({
      where: { templateId: id },
      orderBy: { version: "desc" },
      select: { id: true, version: true, createdByName: true, createdAt: true },
    });
    return okList(versions.map(versionToDto));
  },
  { permission: PERMISSIONS.letters_view }
);
