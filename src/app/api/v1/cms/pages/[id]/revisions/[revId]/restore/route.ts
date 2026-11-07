// MOHD.HMS ENTERPRISE — CMS Page revision restore API (§CMS).
// POST /api/v1/cms/pages/[id]/revisions/[revId]/restore
// Restores a previous revision as the page's current draft content (does not
// auto-publish — the administrator must publish again).

import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { withParams } from "@/lib/hms/files/service";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";

type Ctx = { params: Promise<{ id: string; revId: string }> };

const restoreSchema = z.object({
  changeSummary: z.string().max(500).optional().default("Restored previous revision."),
});

export const POST = withParams<{ id: string; revId: string }>(
  async ({ req, user, params }) => {
    const { id, revId } = params;
    const body = await parseBody(req, restoreSchema);
    const page = await db.page.findUnique({ where: { id }, select: { id: true, status: true, slug: true } });
    if (!page) throw Errors.notFound("Page not found.");
    if (page.status === "ARCHIVED") throw Errors.badRequest("Archived pages cannot be restored.");

    const revision = await db.pageRevision.findUnique({
      where: { id: revId },
      select: { id: true, pageId: true, content: true, version: true },
    });
    if (!revision || revision.pageId !== id) throw Errors.notFound("Revision not found.");

    const updated = await db.page.update({
      where: { id },
      data: { content: revision.content, status: "DRAFT", updatedById: user.id },
      select: { id: true, slug: true, title: true, status: true, updatedAt: true },
    });
    void audit({
      actorId: user.id, actorEmail: user.email, action: "CMS_PAGE_REVISION_RESTORED",
      resourceType: "CMS_PAGE", resourceId: id,
      metadata: { slug: page.slug, restoredRevision: revId, fromVersion: revision.version },
    });
    return ok({ page: updated, restoredFrom: revision.version });
  },
  { permission: PERMISSIONS.cms_pages_update },
);
